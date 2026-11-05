//! Ron Poker table contract.
//!
//! Four players (humans or AI agents) sit at a table. Each buys in for the same amount.
//! A card game needs a dealer who keeps hands hidden, so the game runs on a referee service.
//! When the game ends the referee reports the final points and the contract pays the pot out
//! by points at once: no player has to sign off, so a loser cannot stall the payout.
//!
//! The referee cannot take money. It can only open tables, report results within the pot
//! (points must add up to the buy-ins), and cancel tables with a full refund. If the referee
//! disappears, any player can cancel a table in play after the timeout and get the buy-in back.
//! The shuffle seed is committed when the table opens and revealed with the result, so the
//! deal can be checked afterwards.
//!
//! Money lives in per-account bankrolls inside the contract:
//! - `deposit` (attach NEAR) adds to your bankroll.
//! - `join` takes the buy-in from the attached deposit or, with nothing attached, from your bankroll.
//!   That second path lets an AI agent play with a function-call access key that cannot move NEAR.
//! - `withdraw` needs a 1 yoctoNEAR deposit, which a function-call key cannot attach,
//!   so only the account's full-access key (its owner) can take money out.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
};

pub const SEATS: usize = 4;
/// One hour for a started table to be settled before anyone may abort it.
pub const DEFAULT_TIMEOUT_NS: u64 = 60 * 60 * 1_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Bankrolls,
    Tables,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum TableStatus {
    /// Waiting for every player to pay the buy-in.
    Waiting,
    /// All buy-ins are in. Waiting for the scoresheet.
    Playing,
    /// All four players signed the same scoresheet and the pot was paid out.
    Settled,
    /// Cancelled; every paid buy-in went back to its player.
    Aborted,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Table {
    pub id: u64,
    pub players: Vec<AccountId>,
    pub joined: Vec<bool>,
    /// sha256 (hex) of the shuffle seed, fixed before any card is dealt.
    pub seed_hash: String,
    /// Revealed with the scoresheet.
    pub seed: Option<String>,
    pub status: TableStatus,
    pub buy_in: U128,
    pub start_points: u32,
    /// Public key each player registered when paying in, for authenticating to the referee.
    pub session_keys: Vec<Option<String>>,
    pub final_points: Option<Vec<u32>>,
    pub payouts: Option<Vec<U128>>,
    pub created_at_ns: u64,
    pub started_at_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RonPoker {
    owner: AccountId,
    referee: AccountId,
    bankrolls: LookupMap<AccountId, u128>,
    tables: LookupMap<u64, Table>,
    next_table_id: u64,
    buy_in: u128,
    start_points: u32,
    timeout_ns: u64,
}

#[near]
impl RonPoker {
    /// `referee` opens tables and reports results. `buy_in` in yoctoNEAR (3 NEAR by default),
    /// `start_points` per player (30 by default).
    #[init]
    pub fn new(referee: AccountId, buy_in: Option<U128>, start_points: Option<u32>, timeout_ns: Option<u64>) -> Self {
        let buy_in = buy_in.map(|b| b.0).unwrap_or(NearToken::from_near(3).as_yoctonear());
        let start_points = start_points.unwrap_or(30);
        require!(buy_in > 0 && start_points > 0, "buy-in and start points must be positive");
        require!(buy_in % start_points as u128 == 0, "buy-in must divide evenly into points");
        Self {
            owner: env::predecessor_account_id(),
            referee,
            bankrolls: LookupMap::new(StorageKey::Bankrolls),
            tables: LookupMap::new(StorageKey::Tables),
            next_table_id: 0,
            buy_in,
            start_points,
            timeout_ns: timeout_ns.unwrap_or(DEFAULT_TIMEOUT_NS),
        }
    }

    // ---- bankroll ----------------------------------------------------------

    /// Add the attached NEAR to your bankroll.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit");
        let balance = self.credit(&who, amount);
        log!("deposit: {} +{} (bankroll {})", who, amount, balance);
        U128(balance)
    }

    /// Withdraw from your bankroll (everything if `amount` is omitted).
    /// Requires exactly 1 yoctoNEAR attached, so only a full-access key can call it.
    #[payable]
    pub fn withdraw(&mut self, amount: Option<U128>) -> Promise {
        near_sdk::assert_one_yocto();
        let who = env::predecessor_account_id();
        let balance = self.bankroll(&who);
        let amount = amount.map(|a| a.0).unwrap_or(balance);
        require!(amount > 0, "nothing to withdraw");
        require!(amount <= balance, "amount exceeds bankroll");
        self.bankrolls.insert(who.clone(), balance - amount);
        log!("withdraw: {} -{}", who, amount);
        Promise::new(who).transfer(NearToken::from_yoctonear(amount + 1))
    }

    pub fn bankroll_of(&self, account_id: AccountId) -> U128 {
        U128(self.bankroll(&account_id))
    }

    /// Owner only: point the contract at a new referee service.
    pub fn set_referee(&mut self, referee: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can change the referee");
        log!("referee: {} -> {}", self.referee, referee);
        self.referee = referee;
    }

    // ---- tables ------------------------------------------------------------

    /// Referee only: open a table for four distinct players.
    /// `seed_hash` is the hex sha256 of the shuffle seed, committed before the deal.
    pub fn create_table(&mut self, players: Vec<AccountId>, seed_hash: String) -> u64 {
        let who = env::predecessor_account_id();
        self.assert_referee();
        require!(players.len() == SEATS, "a table needs exactly 4 players");
        for i in 0..SEATS {
            for j in (i + 1)..SEATS {
                require!(players[i] != players[j], "players must be distinct");
            }
        }
        require!(seed_hash.len() == 64 && seed_hash.chars().all(|c| c.is_ascii_hexdigit()), "seed_hash must be 64 hex chars");
        let id = self.next_table_id;
        self.next_table_id += 1;
        let table = Table {
            id,
            players,
            joined: vec![false; SEATS],
            seed_hash: seed_hash.to_lowercase(),
            seed: None,
            status: TableStatus::Waiting,
            buy_in: U128(self.buy_in),
            start_points: self.start_points,
            session_keys: vec![None; SEATS],
            final_points: None,
            payouts: None,
            created_at_ns: env::block_timestamp(),
            started_at_ns: 0,
        };
        self.tables.insert(id, table);
        log!("table {} opened by {}", id, who);
        id
    }

    /// Pay the buy-in for your seat. Attach the buy-in (extra goes to your bankroll),
    /// or attach nothing to pay from your bankroll. `session_key` is the public key your
    /// game client will use to prove to the referee that it plays this seat.
    #[payable]
    pub fn join(&mut self, table_id: u64, session_key: Option<String>) -> TableStatus {
        let who = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let buy_in = self.buy_in;
        if attached > 0 {
            self.credit(&who, attached);
        }
        let mut table = self.table(table_id);
        require!(table.status == TableStatus::Waiting, "table is not taking buy-ins");
        let seat = Self::seat_of(&table, &who);
        require!(!table.joined[seat], "already joined");
        let balance = self.bankroll(&who);
        require!(balance >= buy_in, "bankroll too small for the buy-in");
        self.bankrolls.insert(who.clone(), balance - buy_in);
        table.joined[seat] = true;
        if let Some(k) = session_key {
            require!(k.len() <= 128, "session key too long");
            table.session_keys[seat] = Some(k);
        }
        if table.joined.iter().all(|j| *j) {
            table.status = TableStatus::Playing;
            table.started_at_ns = env::block_timestamp();
            log!("table {}: all buy-ins in, game on", table_id);
        }
        log!("table {}: {} joined seat {}", table_id, who, seat);
        let status = table.status.clone();
        self.tables.insert(table_id, table);
        status
    }

    /// Referee only: report the final points and reveal the seed. The pot is paid out by
    /// points straight into the players' bankrolls.
    pub fn settle(&mut self, table_id: u64, points: Vec<u32>, seed: String) -> Vec<U128> {
        self.assert_referee();
        let mut table = self.table(table_id);
        require!(table.status == TableStatus::Playing, "table is not in play");
        require!(points.len() == SEATS, "points for 4 seats are required");
        let total: u64 = points.iter().map(|p| *p as u64).sum();
        require!(total == table.start_points as u64 * SEATS as u64, "points must add up to the pot");
        require!(hex(&env::sha256(seed.as_bytes())) == table.seed_hash, "seed does not match the committed hash");
        let per_point = table.buy_in.0 / table.start_points as u128;
        let payouts: Vec<U128> = points.iter().map(|p| U128(*p as u128 * per_point)).collect();
        for (player, pay) in table.players.clone().iter().zip(payouts.iter()) {
            if pay.0 > 0 {
                self.credit(player, pay.0);
            }
        }
        table.seed = Some(seed);
        table.final_points = Some(points.clone());
        table.payouts = Some(payouts.clone());
        table.status = TableStatus::Settled;
        log!("table {}: settled {:?}", table_id, points);
        self.tables.insert(table_id, table);
        payouts
    }

    /// Cancel a table and refund every paid buy-in. The referee may cancel any open table.
    /// A player may cancel a waiting table at any time, and a table in play after the timeout
    /// (for example if the referee service is gone).
    pub fn abort(&mut self, table_id: u64) -> TableStatus {
        let who = env::predecessor_account_id();
        let mut table = self.table(table_id);
        let is_referee = who == self.referee;
        if !is_referee {
            Self::seat_of(&table, &who);
        }
        match table.status {
            TableStatus::Waiting => {}
            TableStatus::Playing if is_referee => {}
            TableStatus::Playing => require!(
                env::block_timestamp() >= table.started_at_ns + self.timeout_ns,
                "a table in play can only be aborted after the timeout"
            ),
            _ => env::panic_str("table is already closed"),
        }
        for (player, joined) in table.players.clone().iter().zip(table.joined.iter()) {
            if *joined {
                self.credit(player, table.buy_in.0);
            }
        }
        table.status = TableStatus::Aborted;
        log!("table {}: aborted by {}", table_id, who);
        self.tables.insert(table_id, table);
        TableStatus::Aborted
    }

    pub fn get_table(&self, table_id: u64) -> Option<Table> {
        self.tables.get(&table_id).cloned()
    }

    pub fn get_config(&self) -> (U128, u32, u64, u64, AccountId, AccountId) {
        (U128(self.buy_in), self.start_points, self.timeout_ns, self.next_table_id, self.referee.clone(), self.owner.clone())
    }

    // ---- internal ----------------------------------------------------------

    fn assert_referee(&self) {
        require!(env::predecessor_account_id() == self.referee, "only the referee can do this");
    }

    fn bankroll(&self, who: &AccountId) -> u128 {
        self.bankrolls.get(who).copied().unwrap_or(0)
    }

    fn credit(&mut self, who: &AccountId, amount: u128) -> u128 {
        let balance = self.bankroll(who).checked_add(amount).expect("overflow");
        self.bankrolls.insert(who.clone(), balance);
        balance
    }

    fn table(&self, table_id: u64) -> Table {
        self.tables.get(&table_id).cloned().unwrap_or_else(|| env::panic_str("no such table"))
    }

    fn seat_of(table: &Table, who: &AccountId) -> usize {
        table.players.iter().position(|p| p == who).unwrap_or_else(|| env::panic_str("not a player at this table"))
    }
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const REF: usize = 5;

    fn ctx(who: usize, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(accounts(who)).attached_deposit(NearToken::from_yoctonear(deposit));
        testing_env!(b.build());
    }

    fn at(who: usize, ts: u64) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(accounts(who)).block_timestamp(ts);
        testing_env!(b.build());
    }

    fn players() -> Vec<AccountId> {
        (0..4).map(accounts).collect()
    }

    fn seed() -> (String, String) {
        let seed = "table-seed-123".to_string();
        (seed.clone(), hex(&env::sha256(seed.as_bytes())))
    }

    fn contract() -> RonPoker {
        ctx(4, 0);
        RonPoker::new(accounts(REF), None, None, None)
    }

    fn started() -> (RonPoker, u64, String) {
        let mut c = contract();
        let (seed, hash) = seed();
        ctx(REF, 0);
        let id = c.create_table(players(), hash);
        for i in 0..4 {
            ctx(i, 3 * NEAR);
            c.join(id, Some(format!("ed25519:key{}", i)));
        }
        (c, id, seed)
    }

    #[test]
    fn table_starts_when_all_four_pay() {
        let (c, id, _) = started();
        let t = c.get_table(id).unwrap();
        assert_eq!(t.status, TableStatus::Playing);
        assert_eq!(t.session_keys[2].as_deref(), Some("ed25519:key2"));
    }

    #[test]
    #[should_panic(expected = "only the referee")]
    fn players_cannot_open_tables() {
        let mut c = contract();
        ctx(0, 0);
        c.create_table(players(), seed().1);
    }

    #[test]
    fn join_from_bankroll_without_attaching() {
        let mut c = contract();
        ctx(1, 5 * NEAR);
        c.deposit();
        ctx(REF, 0);
        let id = c.create_table(players(), seed().1);
        ctx(1, 0);
        c.join(id, None);
        assert_eq!(c.bankroll_of(accounts(1)).0, 2 * NEAR);
    }

    #[test]
    #[should_panic(expected = "bankroll too small")]
    fn join_without_money_fails() {
        let mut c = contract();
        ctx(REF, 0);
        let id = c.create_table(players(), seed().1);
        ctx(1, 0);
        c.join(id, None);
    }

    #[test]
    fn referee_settles_and_pot_pays_out_at_once() {
        let (mut c, id, seed) = started();
        ctx(REF, 0);
        c.settle(id, vec![45, 30, 25, 20], seed);
        assert_eq!(c.get_table(id).unwrap().status, TableStatus::Settled);
        // 1 point = 0.1 NEAR
        assert_eq!(c.bankroll_of(accounts(0)).0, 45 * NEAR / 10);
        assert_eq!(c.bankroll_of(accounts(3)).0, 2 * NEAR);
    }

    #[test]
    #[should_panic(expected = "only the referee")]
    fn players_cannot_settle() {
        let (mut c, id, seed) = started();
        ctx(0, 0);
        c.settle(id, vec![120, 0, 0, 0], seed);
    }

    #[test]
    #[should_panic(expected = "seed does not match")]
    fn wrong_seed_is_rejected() {
        let (mut c, id, _) = started();
        ctx(REF, 0);
        c.settle(id, vec![30, 30, 30, 30], "other".into());
    }

    #[test]
    #[should_panic(expected = "add up to the pot")]
    fn referee_cannot_pay_out_more_than_the_pot() {
        let (mut c, id, seed) = started();
        ctx(REF, 0);
        c.settle(id, vec![50, 30, 30, 30], seed);
    }

    #[test]
    #[should_panic(expected = "table is not in play")]
    fn cannot_settle_twice() {
        let (mut c, id, seed) = started();
        ctx(REF, 0);
        c.settle(id, vec![30, 30, 30, 30], seed.clone());
        c.settle(id, vec![30, 30, 30, 30], seed);
    }

    #[test]
    fn player_can_abort_waiting_table_for_refund() {
        let mut c = contract();
        ctx(REF, 0);
        let id = c.create_table(players(), seed().1);
        ctx(0, 3 * NEAR);
        c.join(id, None);
        ctx(0, 0);
        c.abort(id);
        assert_eq!(c.bankroll_of(accounts(0)).0, 3 * NEAR);
    }

    #[test]
    #[should_panic(expected = "only be aborted after the timeout")]
    fn player_cannot_abort_game_in_play_early() {
        let (mut c, id, _) = started();
        ctx(0, 0);
        c.abort(id);
    }

    #[test]
    fn player_gets_refund_if_referee_disappears() {
        let (mut c, id, _) = started();
        at(2, DEFAULT_TIMEOUT_NS + 1);
        c.abort(id);
        for i in 0..4 {
            assert_eq!(c.bankroll_of(accounts(i)).0, 3 * NEAR);
        }
    }

    #[test]
    fn referee_can_cancel_a_game_with_full_refund() {
        let (mut c, id, _) = started();
        ctx(REF, 0);
        c.abort(id);
        assert_eq!(c.bankroll_of(accounts(1)).0, 3 * NEAR);
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn only_owner_changes_referee() {
        let mut c = contract();
        ctx(REF, 0);
        c.set_referee(accounts(0));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn withdraw_needs_full_access_key() {
        let mut c = contract();
        ctx(0, 0);
        c.withdraw(None);
    }
}
