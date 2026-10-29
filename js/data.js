/**
 * ============================================================
 *  WEALTH ENGINE — FICTIONAL DEMO DATA
 *  All values below are illustrative and do not describe a
 *  real person, lender, or financial plan.
 * ============================================================
 */

// ── 1. PLAN PERIOD ──────────────────────────────────────────
export const FORECAST_YEARS = 5;
const startMonth = new Date();
export const MONTHS = Array.from({ length: FORECAST_YEARS * 12 }, (_, index) => {
  const date = new Date(startMonth.getFullYear(), startMonth.getMonth() + index, 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
});
export const NM = MONTHS.length;

// ── 2. MONTHLY INCOME (illustrative) ────────────────────────
export const INCOME = {
  salary: 650000,
  cola:    50000,
};
export const OPENING_BALANCE = 100000;
export const PAYDAY = 25;

// ── 3. FIXED MONTHLY EXPENSES (illustrative) ─────────────────
// Each entry: [display_label, default_amount_naira]
export const FIXED_DEF = {
  housing:   ['Housing',             80000],
  groceries: ['Groceries',           45000],
  utilities: ['Utilities / Internet',18000],
  health:    ['Health',              12000],
  transport: ['Transport',           25000],
  household: ['Household Help',      15000],
  personal:  ['Personal Care',        8000],
  clothing:  ['Clothing',             8000],
};
export const FIXED_DUE_DAYS = {
  housing: 1,
  groceries: 5,
  utilities: 8,
  health: 10,
  transport: 1,
  household: 12,
  personal: 15,
  clothing: 20,
};

// ── 4. VARIABLE EXPENSES (illustrative) ─────────────────────
// Values are month-specific from the current month; omitted later months mean no payment.
export const VARIABLE = {
  // Combined payments for the two sample loans.
  loan_bundle: [
    115000,115000,115000,115000,115000,115000,115000,
    115000,115000,115000,115000,115000,40000,
  ],

  // Three-month sample short-term loan repayment.
  short_term_loan: [
    25000,25000,25000,
    0,0,0,0,0,0,0,0,0,0,
  ],

  // Sample savings goals.
  savings_goal_1: [
    30000,30000,30000,30000,30000,30000,30000,30000,
    0,0,0,0,0,
  ],
  savings_goal_2: [
    25000,25000,25000,25000,25000,25000,25000,25000,25000,
    0,0,0,0,
  ],

  // Sample community savings pool and planned home project payments.
  community_pool: [
    0,
    20000,20000,20000,20000,20000,20000,20000,
    0,0,0,0,0,
  ],
  family_support: [
    0,
    15000,15000,15000,15000,15000,
    20000,20000,20000,20000,20000,20000,20000,
  ],
  home_project: [
    0,
    100000,0,50000,0,0,50000,0,0,50000,0,0,50000,
  ],
};
export const VARIABLE_DUE_DAYS = {
  loan_bundle: 15,
  short_term_loan: 10,
  savings_goal_1: 27,
  savings_goal_2: 27,
  community_pool: 20,
  family_support: 5,
  home_project: 1,
};

// ── 5. SAMPLE DEBTS ──────────────────────────────────────────
// Balances and terms are invented for demonstration.
export const DEBTS = [
  {
    name:    'Sample Lender — Loan A',
    balance: 720000,
    opening: 800000,
    rate_pa: 18,
    monthly: 75000,
    end:     'Nov 2027',
    status:  'active',
    note:    'Illustrative reducing-balance loan',
  },
  {
    name:    'Sample Lender — Loan B',
    balance: 480000,
    opening: 500000,
    rate_pa: 8,
    monthly: 40000,
    end:     'Dec 2027+',
    status:  'active',
    note:    'Illustrative reducing-balance loan',
  },
  {
    name:    'Sample Short-Term Loan',
    balance: 50000,
    opening: 75000,
    rate_pa: 0,
    monthly: 25000,
    end:     'Feb 2027',
    status:  'active',
    note:    'Illustrative three-month repayment',
  },
  {
    name:    'Sample Settlement Account',
    balance: 180000,
    opening: 240000,
    rate_pa: 0,
    monthly: 0,
    end:     'Pending',
    status:  'negotiating',
    note:    'Illustrative balance under review',
  },
  {
    name:    'Sample Community Pool',
    balance: 140000,
    opening: 140000,
    rate_pa: 0,
    monthly: 0,
    end:     'Aug 2027',
    status:  'active',
    note:    'Illustrative informal balance',
  },
];

// ── 6. SAVINGS GOALS (illustrative) ─────────────────────────
export const SAVINGS_GOALS = [
  {
    name:     'Savings Goal 1',
    key:      'savings_goal_1',
    target:   240000,
    purpose:  'Sample planned savings',
    deadline: 'Jul 2027',
    color:    'teal',
  },
  {
    name:     'Savings Goal 2',
    key:      'savings_goal_2',
    target:   225000,
    purpose:  'Sample planned savings',
    deadline: 'Aug 2027',
    color:    'teal',
  },
  {
    name:     'Home Fund (Total)',
    key:      '__rent__',
    target:   500000,
    purpose:  'Illustrative home-fund target',
    deadline: 'Aug 2027',
    color:    'teal',
  },
  {
    name:     'Community Pool',
    key:      'community_pool',
    target:   140000,
    purpose:  'Illustrative pool target',
    deadline: 'Aug 2027',
    color:    'gold',
  },
];

// ── 7. BRAND / VISUAL TOKENS ────────────────────────────────
export const BRAND = {
  red:   '#C0392B',
  redD:  '#7B241C',
  gold:  '#F39C12',
  teal:  '#1ABC9C',
  navy:  '#1A252F',
  grey:  '#566573',
};
