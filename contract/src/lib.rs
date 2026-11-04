//! Ron Poker table contract.
//!
//! Four players (humans or AI agents) sit at a table. Each buys in for the same amount.
//! The game itself runs off-chain; when it ends, every player submits the final scoresheet.
//! The pot is paid out only when all four submit the same scoresheet, so there is no house
//! and no single party can decide the result.
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
    /// Each player's submitted final points, if any.
    pub submissions: Vec<Option<Vec<u32>>>,
    pub final_points: Option<Vec<u32>>,
    pub payouts: Option<Vec<U128>>,
    pub created_at_ns: u64,
    pub started_at_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RonPoker {
    bankrolls: LookupMap<AccountId, u128>,
    tables: LookupMap<u64, Table>,
    next_table_id: u64,
    buy_in: u128,
    start_points: u32,
    timeout_ns: u64,
}

#[near]
impl RonPoker {
    /// `buy_in` in yoctoNEAR (3 NEAR by default), `start_points` per player (30 by default).
    #[init]
    pub fn new(buy_in: Option<U128>, start_points: Option<u32>, timeout_ns: Option<u64>) -> Self {
        let buy_in = buy_in.map(|b| b.0).unwrap_or(NearToken::from_near(3).as_yoctonear());
        let start_points = start_points.unwrap_or(30);
        require!(buy_in > 0 && start_points > 0, "buy-in and start points must be positive");
        require!(buy_in % start_points as u128 == 0, "buy-in must divide evenly into points");
        Self {
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

    // ---- tables ------------------------------------------------------------

    /// Open a table for four distinct players. The caller must be one of them.
    /// `seed_hash` is the hex sha256 of the shuffle seed, committed before the deal.
    pub fn create_table(&mut self, players: Vec<AccountId>, seed_hash: String) -> u64 {
        let who = env::predecessor_account_id();
        require!(players.len() == SEATS, "a table needs exactly 4 players");
        for i in 0..SEATS {
            for j in (i + 1)..SEATS {
                require!(players[i] != players[j], "players must be distinct");
            }
        }
        require!(players.contains(&who), "the creator must sit at the table");
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
            submissions: vec![None; SEATS],
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
    /// or attach nothing to pay from your bankroll.
    #[payable]
    pub fn join(&mut self, table_id: u64) -> TableStatus {
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

    /// Submit the final points and reveal the seed. When all four players have submitted
    /// the same points, the pot is split by points and credited to bankrolls.
    pub fn submit_result(&mut self, table_id: u64, points: Vec<u32>, seed: String) -> TableStatus {
        let who = env::predecessor_account_id();
        let mut table = self.table(table_id);
        require!(table.status == TableStatus::Playing, "table is not in play");
        let seat = Self::seat_of(&table, &who);
        require!(points.len() == SEATS, "points for 4 seats are required");
        let total: u64 = points.iter().map(|p| *p as u64).sum();
        require!(total == table.start_points as u64 * SEATS as u64, "points must add up to the pot");
        require!(hex(&env::sha256(seed.as_bytes())) == table.seed_hash, "seed does not match the committed hash");
        table.submissions[seat] = Some(points.clone());
        if table.seed.is_none() {
            table.seed = Some(seed);
        }
        log!("table {}: {} submitted {:?}", table_id, who, points);

        let agreed = table.submissions.iter().all(|s| s.as_ref() == Some(&points));
        if agreed {
            let per_point = table.buy_in.0 / table.start_points as u128;
            let payouts: Vec<U128> = points.iter().map(|p| U128(*p as u128 * per_point)).collect();
            for (player, pay) in table.players.clone().iter().zip(payouts.iter()) {
                if pay.0 > 0 {
                    self.credit(player, pay.0);
                }
            }
            table.final_points = Some(points);
            table.payouts = Some(payouts);
            table.status = TableStatus::Settled;
            log!("table {}: settled", table_id);
        }
        let status = table.status.clone();
        self.tables.insert(table_id, table);
        status
    }

    /// Cancel a table and refund every paid buy-in. A waiting table can be aborted by any of its
    /// players at any time; a table in play only after the timeout (players who never agree).
    pub fn abort(&mut self, table_id: u64) -> TableStatus {
        let who = env::predecessor_account_id();
        let mut table = self.table(table_id);
        Self::seat_of(&table, &who);
        match table.status {
            TableStatus::Waiting => {}
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

    pub fn get_config(&self) -> (U128, u32, u64, u64) {
        (U128(self.buy_in), self.start_points, self.timeout_ns, self.next_table_id)
    }

    // ---- internal ----------------------------------------------------------

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

    fn ctx(who: usize, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(accounts(who)).attached_deposit(NearToken::from_yoctonear(deposit));
        testing_env!(b.build());
    }

    fn players() -> Vec<AccountId> {
        (0..4).map(accounts).collect()
    }

    fn seed() -> (String, String) {
        let seed = "table-seed-123".to_string();
        (seed.clone(), hex(&env::sha256(seed.as_bytes())))
    }

    fn started() -> (RonPoker, u64, String) {
        ctx(0, 0);
        let mut c = RonPoker::new(None, None, None);
        let (seed, hash) = seed();
        let id = c.create_table(players(), hash);
        for i in 0..4 {
            ctx(i, 3 * NEAR);
            c.join(id);
        }
        (c, id, seed)
    }

    #[test]
    fn table_starts_when_all_four_pay() {
        let (c, id, _) = started();
        assert_eq!(c.get_table(id).unwrap().status, TableStatus::Playing);
    }

    #[test]
    fn join_from_bankroll_without_attaching() {
        ctx(0, 0);
        let mut c = RonPoker::new(None, None, None);
        ctx(1, 5 * NEAR);
        c.deposit();
        ctx(0, 0);
        let id = c.create_table(players(), seed().1);
        ctx(1, 0);
        c.join(id);
        assert_eq!(c.bankroll_of(accounts(1)).0, 2 * NEAR);
    }

    #[test]
    #[should_panic(expected = "bankroll too small")]
    fn join_without_money_fails() {
        ctx(0, 0);
        let mut c = RonPoker::new(None, None, None);
        let id = c.create_table(players(), seed().1);
        ctx(1, 0);
        c.join(id);
    }

    #[test]
    fn pays_out_only_when_all_agree() {
        let (mut c, id, seed) = started();
        let result = vec![45, 30, 25, 20];
        for i in 0..3 {
            ctx(i, 0);
            assert_eq!(c.submit_result(id, result.clone(), seed.clone()), TableStatus::Playing);
        }
        ctx(3, 0);
        assert_eq!(c.submit_result(id, result, seed), TableStatus::Settled);
        // 1 point = 0.1 NEAR
        assert_eq!(c.bankroll_of(accounts(0)).0, 45 * NEAR / 10);
        assert_eq!(c.bankroll_of(accounts(3)).0, 2 * NEAR);
    }

    #[test]
    fn disagreement_keeps_the_pot_locked() {
        let (mut c, id, seed) = started();
        for i in 0..3 {
            ctx(i, 0);
            c.submit_result(id, vec![45, 30, 25, 20], seed.clone());
        }
        ctx(3, 0);
        assert_eq!(c.submit_result(id, vec![20, 30, 25, 45], seed), TableStatus::Playing);
        assert_eq!(c.bankroll_of(accounts(0)).0, 0);
    }

    #[test]
    #[should_panic(expected = "seed does not match")]
    fn wrong_seed_is_rejected() {
        let (mut c, id, _) = started();
        ctx(0, 0);
        c.submit_result(id, vec![30, 30, 30, 30], "other".into());
    }

    #[test]
    #[should_panic(expected = "add up to the pot")]
    fn points_must_sum_to_pot() {
        let (mut c, id, seed) = started();
        ctx(0, 0);
        c.submit_result(id, vec![50, 30, 30, 30], seed);
    }

    #[test]
    fn abort_waiting_table_refunds() {
        ctx(0, 0);
        let mut c = RonPoker::new(None, None, None);
        let id = c.create_table(players(), seed().1);
        ctx(0, 3 * NEAR);
        c.join(id);
        ctx(0, 0);
        c.abort(id);
        assert_eq!(c.bankroll_of(accounts(0)).0, 3 * NEAR);
    }

    #[test]
    #[should_panic(expected = "only be aborted after the timeout")]
    fn cannot_abort_game_in_play_early() {
        let (mut c, id, _) = started();
        ctx(0, 0);
        c.abort(id);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn withdraw_needs_full_access_key() {
        ctx(0, 0);
        let mut c = RonPoker::new(None, None, None);
        c.withdraw(None);
    }
}
