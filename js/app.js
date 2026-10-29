/**
 * ============================================================
 *  WEALTH ENGINE — APPLICATION LOGIC
 *  Imports all data from data.js, wires up the UI, computes
 *  cash flow, and renders charts via Chart.js.
 *  ─────────────────────────────────────────────────────────
 *  To customise: edit data.js only.
 *  To add a new tab: add a panel div in index.html, a tab
 *  button, and a render function here following the pattern.
 * ============================================================
 */

import {
  MONTHS as DEFAULT_MONTHS, NM as DEFAULT_NM, FORECAST_YEARS, INCOME, FIXED_DEF, VARIABLE, OPENING_BALANCE, PAYDAY,
  FIXED_DUE_DAYS, VARIABLE_DUE_DAYS,
  DEBTS, SAVINGS_GOALS, BRAND,
} from './data.js';

const MAX_FORECAST_YEARS = 10;
const MAX_NM = MAX_FORECAST_YEARS * 12;
let forecastYears = FORECAST_YEARS;
let MONTHS = [...DEFAULT_MONTHS];
let NM = DEFAULT_NM;
const DEFAULT_FIXED = Object.fromEntries(
  Object.entries(FIXED_DEF).map(([key, [label, amount]]) => [key, [label, amount]])
);
let openingBalance = OPENING_BALANCE;
let payday = PAYDAY;
let fixedDueDays = { ...FIXED_DUE_DAYS };
let variableDueDays = { ...VARIABLE_DUE_DAYS };
const CASHFLOW_HIDDEN_KEY = 'wealth-engine-hidden-categories';
const ACCOUNT_SESSION_KEY = 'wealth-engine-account-session';
const API_BASE = String(window.WEALTH_ENGINE_API_BASE || '/api').replace(/\/+$/, '');
const ACCOUNT_DATA_URL = `${API_BASE}/account/data`;
let isAccountMode = false;
let accountSession = null;
let accountUser = null;
let accountData = { plan: null, scenarios: {}, actuals: [], debts: [], savings_goals: [] };
let accountSaveTimer;
let accountSaveQueue = Promise.resolve();
let suppressPlanSave = false;
const CATEGORY_ORDER = [
  'loan_bundle', 'short_term_loan', 'savings_goal_1', 'savings_goal_2',
  'community_pool', 'family_support', 'home_project',
];
const makeForecastMonths = years => {
  const startMonth = new Date();
  return Array.from({ length: years * 12 }, (_, index) => {
    const date = new Date(startMonth.getFullYear(), startMonth.getMonth() + index, 1);
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  });
};
const populateCashflowMonthSelect = () => {
  const select = document.getElementById('cashflow-month');
  if (!select) return;
  const previousIndex = Number(select.value);
  const selectedIndex = Number.isInteger(previousIndex)
    ? Math.min(Math.max(previousIndex, 0), MONTHS.length - 1)
    : 0;
  select.innerHTML = MONTHS.map((month, index) =>
    `<option value="${index}">${month}</option>`
  ).join('');
  select.value = String(selectedIndex);
};
const setForecastDuration = years => {
  if (!Number.isInteger(years) || years < 1 || years > MAX_FORECAST_YEARS) return false;
  forecastYears = years;
  MONTHS = makeForecastMonths(forecastYears);
  NM = MONTHS.length;
  const select = document.getElementById('forecast-years');
  if (select) select.value = String(forecastYears);
  populateCashflowMonthSelect();
  return true;
};
const MANAGED_DEBT_PREFIX = 'private_debt_';
const MANAGED_SAVINGS_PREFIX = 'private_savings_';
const isManagedExpenseKey = key => key.startsWith(MANAGED_DEBT_PREFIX) || key.startsWith(MANAGED_SAVINGS_PREFIX);
const makeDebtProjection = debt => {
  let balance = debt.balance;
  const payments = [];
  const balances = [];
  for (let month = 0; month < MAX_NM; month++) {
    balances.push(Math.round(balance));
    const due = balance + balance * debt.annual_interest_rate / 100 / 12;
    const payment = Math.min(debt.monthly_payment, Math.ceil(due));
    payments.push(payment);
    balance = Math.max(0, due - payment);
  }
  return { payments, balances };
};
const makeSavingsSchedule = goal => {
  let remaining = Math.max(0, goal.target_amount - goal.saved_amount);
  return Array.from({ length: MAX_NM }, () => {
    const contribution = Math.min(goal.monthly_contribution, remaining);
    remaining -= contribution;
    return contribution;
  });
};
const syncAccountEntitySchedules = () => {
  Object.keys(VARIABLE).filter(isManagedExpenseKey).forEach((key) => {
    delete VARIABLE[key];
    delete FIXED_DEF[key];
    delete variableDueDays[key];
  });
  accountData.debts.forEach((debt) => {
    const id = String(debt.id).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
    if (!id) return;
    const key = `${MANAGED_DEBT_PREFIX}${id}`;
    VARIABLE[key] = makeDebtProjection(debt).payments;
    variableDueDays[key] = debt.due_day;
  });
  accountData.savings_goals.forEach((goal) => {
    const id = String(goal.id).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
    if (!id) return;
    const key = `${MANAGED_SAVINGS_PREFIX}${id}`;
    VARIABLE[key] = makeSavingsSchedule(goal);
    variableDueDays[key] = goal.contribution_day;
  });
};
const getScheduleStartMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};
const alignVariableSchedule = (values, storedStartMonth) => {
  const match = /^(\d{4})-(\d{2})$/.exec(storedStartMonth || '');
  if (!match) return Array.from({ length: MAX_NM }, (_, index) => Number(values[index]) || 0);
  const now = new Date();
  const currentIndex = now.getFullYear() * 12 + now.getMonth();
  const savedIndex = Number(match[1]) * 12 + Number(match[2]) - 1;
  const elapsedMonths = currentIndex - savedIndex;
  return Array.from({ length: MAX_NM }, (_, index) => Number(values[index + elapsedMonths]) || 0);
};
// ── CHART REGISTRY (for clean re-renders) ──────────────────
const CHARTS = {};
const THEME_KEY = 'wealth-engine-theme';
let toastTimer;

const showToast = (message, isError = false) => {
  const toast = document.getElementById('action-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
};

const getSession = () => {
  try {
    return sessionStorage.getItem(ACCOUNT_SESSION_KEY);
  } catch (error) {
    throw new Error('Session storage is unavailable in this browser.');
  }
};

const setSession = session => {
  const expiresAt = Number(session.expires_at) || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
  accountSession = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: expiresAt,
  };
  try {
    sessionStorage.setItem(ACCOUNT_SESSION_KEY, JSON.stringify(accountSession));
  } catch (error) {
    accountSession = null;
    throw new Error('Could not store your sign-in session in this browser.');
  }
};

const clearSession = () => {
  accountSession = null;
  try {
    sessionStorage.removeItem(ACCOUNT_SESSION_KEY);
  } catch (error) {
    showToast('Could not clear the saved sign-in session from this browser.', true);
  }
};

const refreshSessionIfNeeded = async () => {
  if (!accountSession || accountSession.expires_at > Math.floor(Date.now() / 1000) + 30) return;
  if (!accountSession.refresh_token) throw new Error('Your sign-in session expired. Please sign in again.');
  let refreshed;
  try {
    refreshed = await requestApi('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: accountSession.refresh_token },
      authenticate: false,
    });
  } catch (error) {
    clearSession();
    throw new Error('Your sign-in session expired. Please sign in again.');
  }
  if (!refreshed.access_token || !refreshed.refresh_token) {
    clearSession();
    throw new Error('Could not refresh your sign-in session. Please sign in again.');
  }
  setSession(refreshed);
};

const requestApi = async (path, { method = 'GET', body, authenticate = true } = {}) => {
  if (authenticate) await refreshSessionIfNeeded();
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authenticate && accountSession?.access_token) {
    headers.Authorization = `Bearer ${accountSession.access_token}`;
  }
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new Error('Could not reach the Wealth Engine API. Check your connection and try again.');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    if (response.ok) throw new Error('The Wealth Engine API returned an invalid response.');
  }
  if (!response.ok) {
    const detail = payload?.detail || payload?.msg || payload?.message;
    if (response.status === 401 && authenticate) {
      clearSession();
      if (isAccountMode) lockAccountView();
    }
    if (response.status === 404 && !detail) {
      throw new Error('The account API is not running on this address. Start the app with `npx vercel dev`; a static Live Server cannot sign in.');
    }
    throw new Error(typeof detail === 'string' ? detail : `The request failed (${response.status}).`);
  }
  return payload;
};

const persistAccountData = () => {
  if (!isAccountMode) return Promise.reject(new Error('Sign in before saving account data.'));
  const payload = JSON.parse(JSON.stringify(accountData));
  accountSaveQueue = accountSaveQueue.catch(() => {}).then(async () => {
    await requestApi('/account/data', { method: 'PUT', body: { data: payload } });
  });
  return accountSaveQueue;
};

const queueAccountSave = () => {
  if (!isAccountMode) return;
  clearTimeout(accountSaveTimer);
  accountSaveTimer = setTimeout(() => {
    persistAccountData()
      .then(() => showToast('Changes saved to your private account.'))
      .catch(error => showToast(error.message || 'Could not save your account data.', true));
  }, 500);
};

// ── THEME HELPERS ─────────────────────────────────────────
const getStoredTheme = () => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch (err) {
    // Ignore storage access failures in restricted environments.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const applyTheme = (theme) => {
  const nextTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', nextTheme);
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    const isDark = nextTheme === 'dark';
    toggle.innerHTML = isDark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"></path></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.4A8.5 8.5 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z"></path></svg>';
    toggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    toggle.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    toggle.setAttribute('aria-pressed', String(isDark));
  }
  try {
    localStorage.setItem(THEME_KEY, nextTheme);
  } catch (err) {
    // Ignore storage access failures.
  }
};

// ── FORMATTING HELPERS ─────────────────────────────────────
const fmt = (v) => {
  if (!v && v !== 0) return '–';
  if (v === 0) return '–';
  const a = Math.abs(v);
  const s = '₦' + a.toLocaleString('en-NG', { maximumFractionDigits: 0 });
  return v < 0 ? '-' + s : s;
};

const fmtK = (v) => {
  const a = Math.abs(v);
  let s;
  if (a >= 1e6)      s = '₦' + (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  else if (a >= 1e3) s = '₦' + (a / 1e3).toFixed(0) + 'k';
  else               s = '₦' + a.toLocaleString();
  return v < 0 ? '-' + s : s;
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const isDark = () => {
  const dt = document.documentElement.getAttribute('data-theme');
  if (dt === 'dark')  return true;
  if (dt === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

// Chart.js scale/grid colours for current theme
const gc = () => ({
  grid: isDark() ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.05)',
  tick: isDark() ? '#7F99AB' : '#566573',
});

const destroyChart = (id) => {
  if (CHARTS[id]) { CHARTS[id].destroy(); delete CHARTS[id]; }
};

// ── READ CURRENT INPUT VALUES ──────────────────────────────
const getFixed = () => {
  const f = {};
  Object.keys(FIXED_DEF).forEach((k) => {
    const el = document.getElementById('inp-f-' + k);
    f[k] = el ? (parseFloat(el.value) || 0) : FIXED_DEF[k][1];
  });
  return f;
};

const getSalary = () => {
  const value = Number.parseFloat(document.getElementById('inp-salary')?.value);
  return Number.isFinite(value) ? value : INCOME.salary;
};
const getCola = () => {
  const value = Number.parseFloat(document.getElementById('inp-cola')?.value);
  return Number.isFinite(value) ? value : INCOME.cola;
};
const readDay = (id, fallback) => {
  const value = Number.parseInt(document.getElementById(id)?.value, 10);
  return Number.isInteger(value) ? Math.min(31, Math.max(1, value)) : fallback;
};
const getOpeningBalance = () => {
  const value = Number.parseFloat(document.getElementById('inp-opening-balance')?.value);
  return Number.isFinite(value) ? value : openingBalance;
};
const getPayday = () => readDay('inp-payday', payday);
const getFixedDueDays = () => Object.fromEntries(
  Object.keys(FIXED_DEF).map(key => [key, readDay(`inp-fixed-day-${key}`, fixedDueDays[key] || 1)])
);
const getVariableDueDays = () => Object.fromEntries(
  Object.keys(VARIABLE).map(key => [key, readDay(`inp-variable-day-${key}`, variableDueDays[key] || 1)])
);
const MONTH_INDEX = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
const getMonthDate = (monthIndex, day) => {
  const [monthName, year] = MONTHS[monthIndex].split(' ');
  const monthNumber = MONTH_INDEX[monthName];
  const fullYear = Number(year);
  const monthEnd = new Date(fullYear, monthNumber + 1, 0).getDate();
  return new Date(fullYear, monthNumber, Math.min(day, monthEnd));
};
const fmtDate = date => date.toLocaleDateString('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric',
});

// ── CORE COMPUTATION ───────────────────────────────────────
// Returns an array of row objects, one per month.
const compute = () => {
  const income   = getSalary() + getCola();
  const fixed    = getFixed();
  const startBalance = getOpeningBalance();
  const payDay = getPayday();
  const fixedDays = getFixedDueDays();
  const variableDays = getVariableDueDays();
  const fixedSum = Object.values(fixed).reduce((a, b) => a + b, 0);
  let balance = startBalance;

  return Array.from({ length: NM }, (_, m) => {
    const varSum = Object.values(VARIABLE).reduce((s, arr) => s + (arr[m] || 0), 0);
    const exp    = fixedSum + varSum;
    const net    = income - exp;
    const events = [];
    if (income > 0) {
      events.push({ date: getMonthDate(m, payDay), amount: income, label: 'Salary + allowances', kind: 'income' });
    }
    Object.entries(fixed).forEach(([key, amount]) => {
      if (amount > 0) {
        events.push({
          date: getMonthDate(m, fixedDays[key]),
          amount: -amount,
          label: FIXED_DEF[key][0],
          kind: 'expense',
        });
      }
    });
    Object.entries(VARIABLE).forEach(([key, values]) => {
      const amount = values[m] || 0;
      if (amount > 0) {
        events.push({
          date: getMonthDate(m, variableDays[key]),
          amount: -amount,
          label: getVariableCategoryLabels()[key] || key.replace(/_/g, ' '),
          kind: 'expense',
        });
      }
    });
    events.sort((a, b) => a.date - b.date
      || (a.kind === b.kind ? 0 : a.kind === 'expense' ? -1 : 1));

    let minBalance = balance;
    let minDate = getMonthDate(m, 1);
    events.forEach((event) => {
      balance += event.amount;
      if (balance < minBalance) {
        minBalance = balance;
        minDate = event.date;
      }
    });
    return {
      m, month: MONTHS[m], income, fixedSum, varSum, exp, net,
      cum: balance, openingBalance: m === 0 ? startBalance : undefined,
      closingBalance: balance, minBalance, minDate, events, fixed,
    };
  });
};

// ── MASTER RECOMPUTE (called on every input change) ────────
const getCurrentPlanData = () => {
  const plan = {
    forecastYears,
    income: { salary: getSalary(), cola: getCola() },
    fixed: getFixed(),
    variable: {},
    openingBalance: getOpeningBalance(),
    payday: getPayday(),
    scheduleStartMonth: getScheduleStartMonth(),
    fixedDueDays: getFixedDueDays(),
    variableDueDays: getVariableDueDays(),
  };

  Object.keys(VARIABLE).forEach((key) => {
    plan.variable[key] = [...VARIABLE[key]];
  });
  return plan;
};

const saveCurrentPlan = (notify = false) => {
  if (!isAccountMode) {
    if (notify) showToast('Sign in to save a private plan.', true);
    return false;
  }
  accountData.plan = getCurrentPlanData();
  if (accountData.scenarios.Current) accountData.scenarios.Current = accountData.plan;
  if (notify) {
    clearTimeout(accountSaveTimer);
    persistAccountData()
      .then(() => showToast('Plan saved to your private account.'))
      .catch(error => showToast(error.message || 'Could not save your plan.', true));
  } else {
    queueAccountSave();
  }
  return true;
};

const loadSavedPlan = (saved) => {
  try {
    if (!saved || typeof saved !== 'object') return false;
    const savedForecastYears = Number(saved.forecastYears);
    const hasSavedForecastYears = saved.forecastYears !== undefined && saved.forecastYears !== null;
    const validForecastYears = Number.isInteger(savedForecastYears)
      && savedForecastYears >= 1 && savedForecastYears <= MAX_FORECAST_YEARS;
    if (hasSavedForecastYears && !validForecastYears) {
      showToast('The saved forecast duration is invalid; using the five-year default.', true);
    }
    setForecastDuration(validForecastYears ? savedForecastYears : FORECAST_YEARS);

    Object.keys(saved.variable || {}).forEach((key) => {
      if (!/^[a-zA-Z0-9_]{1,48}$/.test(key)) return;
      if (!Object.prototype.hasOwnProperty.call(VARIABLE, key)) {
        VARIABLE[key] = Array(MAX_NM).fill(0);
        if (!isManagedExpenseKey(key)) {
          const label = key.replace(/_/g, ' ');
          FIXED_DEF[key] = [label, 0];
        }
      }
    });
    if (saved.income) {
      const salary = Number(saved.income.salary);
      const cola = Number(saved.income.cola);
      if (Number.isFinite(salary)) INCOME.salary = salary;
      if (Number.isFinite(cola)) INCOME.cola = cola;
    }
    if (Number.isFinite(Number(saved.openingBalance))) openingBalance = Number(saved.openingBalance);
    if (Number.isInteger(Number(saved.payday))) payday = Math.min(31, Math.max(1, Number(saved.payday)));
    if (saved.fixedDueDays && typeof saved.fixedDueDays === 'object') {
      Object.keys(FIXED_DEF).forEach((key) => {
        const day = Number(saved.fixedDueDays[key]);
        if (Number.isInteger(day)) fixedDueDays[key] = Math.min(31, Math.max(1, day));
      });
    }
    if (saved.variableDueDays && typeof saved.variableDueDays === 'object') {
      Object.keys(VARIABLE).forEach((key) => {
        const day = Number(saved.variableDueDays[key]);
        if (Number.isInteger(day)) variableDueDays[key] = Math.min(31, Math.max(1, day));
      });
    }

    Object.keys(FIXED_DEF).forEach((key) => {
      if (saved.fixed && Number.isFinite(Number(saved.fixed[key]))) {
        FIXED_DEF[key][1] = Number(saved.fixed[key]);
      }
    });

    Object.keys(VARIABLE).forEach((key) => {
      if (saved.variable && Array.isArray(saved.variable[key])) {
        VARIABLE[key] = alignVariableSchedule(saved.variable[key], saved.scheduleStartMonth);
      }
    });

    return true;
  } catch (err) {
    showToast('The saved plan could not be loaded.', true);
    return false;
  }
};

const getPlanSnapshot = () => {
  const rows = compute();
  const rentTarget = SAVINGS_GOALS.find(g => g.key === '__rent__')?.target || 851000;
  const rentProjected = [...(VARIABLE.savings_goal_1 || []), ...(VARIABLE.savings_goal_2 || [])]
    .reduce((sum, value) => sum + value, 0);
  const summary = {
    netPeriod: rows.reduce((s, row) => s + row.net, 0),
    endBalance: rows.at(-1)?.cum || 0,
    deficitMonths: rows.filter(row => row.minBalance < 0).length,
    lowestBalance: Math.min(...rows.map(row => row.minBalance)),
    lowestBalanceDate: fmtDate(rows.reduce((lowest, row) => row.minBalance < lowest.minBalance ? row : lowest, rows[0]).minDate),
  };
  if (!isAccountMode) {
    summary.rentProjected = rentProjected;
    summary.rentTarget = rentTarget;
    summary.rentGap = Math.max(0, rentTarget - rentProjected);
  }

  return {
    generatedAt: new Date().toISOString(),
    income: {
      salary: getSalary(),
      cola: getCola(),
      total: getSalary() + getCola(),
    },
    fixed: { ...getFixed() },
    variable: Object.fromEntries(Object.entries(VARIABLE).map(([key, values]) => [key, [...values]])),
    openingBalance: getOpeningBalance(),
    payday: getPayday(),
    scheduleStartMonth: getScheduleStartMonth(),
    fixedDueDays: getFixedDueDays(),
    variableDueDays: getVariableDueDays(),
    summary,
    monthly: rows.map((row) => ({
      month: row.month,
      income: row.income,
      expenses: row.exp,
      net: row.net,
      cumulative: row.cum,
      lowestBalance: row.minBalance,
      lowestBalanceDate: fmtDate(row.minDate),
    })),
  };
};

const exportPlan = () => {
  const snapshot = getPlanSnapshot();
  const payload = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `wealth-engine-plan-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('Plan export downloaded.');
};

const exportCsv = () => {
  const rows = compute();
  const variableKeys = Object.keys(VARIABLE);
  const fixedKeys = Object.keys(FIXED_DEF);
  const variableLabels = getVariableCategoryLabels();
  const variableDays = getVariableDueDays();
  const fixedDays = getFixedDueDays();
  const payDay = getPayday();
  const headers = [
    'Month',
    `Income (payday ${payDay})`,
    ...variableKeys.map(key => `Variable: ${variableLabels[key] || key} (day ${variableDays[key]})`),
    ...fixedKeys.map(key => `Fixed: ${FIXED_DEF[key][0]} (day ${fixedDays[key]})`),
    'Expenses',
    'Net',
    'Cumulative',
    'Lowest balance',
    'Lowest balance date',
  ];
  const csvCell = value => `"${String(value).replace(/"/g, '""')}"`;
  const csvRows = [headers.map(csvCell).join(',')];
  rows.forEach((row) => {
    csvRows.push([
      row.month,
      row.income,
      ...variableKeys.map(key => VARIABLE[key][row.m] || 0),
      ...fixedKeys.map(key => row.fixed[key] || 0),
      row.exp,
      row.net,
      row.cum,
      row.minBalance,
      fmtDate(row.minDate),
    ].map(csvCell).join(','));
  });

  const blob = new Blob(['\uFEFF', csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `wealth-engine-cashflow-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('Cash-flow CSV downloaded.');
};

const printSummary = () => {
  const summary = document.getElementById('plan-summary');
  const cashRisk = document.getElementById('cash-risk');
  const kpis = document.getElementById('kpi-grid');
  const insights = document.getElementById('insights-grid');
  const printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) {
    showToast('Allow pop-ups to print the summary.', true);
    return;
  }

  const html = `
    <html><head><title>Wealth Engine Summary</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #1a252f; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 12px; margin-top: 16px; }
        .card { border: 1px solid #dde2e6; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
        .cash-risk { border: 1px solid #dde2e6; padding: 12px; margin: 16px 0; }
        .cash-risk__table { width: 100%; border-collapse: collapse; }
        .cash-risk__table td, .cash-risk__table th { border-bottom: 1px solid #dde2e6; padding: 6px; text-align: left; }
        .label { font-size: 10px; text-transform: uppercase; color: #566573; }
        .value { font-size: 22px; font-weight: 700; }
        .note { font-size: 12px; color: #566573; }
      </style>
    </head><body>
      <h1>Wealth Engine Summary</h1>
      ${summary ? summary.outerHTML : ''}
      ${cashRisk ? cashRisk.outerHTML : ''}
      ${kpis ? '<div class="grid">' + kpis.innerHTML + '</div>' : ''}
      ${insights ? '<div class="grid">' + insights.innerHTML + '</div>' : ''}
    </body></html>
  `;
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
  showToast('Print summary opened.');
};

const getVariableCategoryLabels = () => ({
  ...(!isAccountMode ? {
    loan_bundle: 'Sample Loans A + B',
    short_term_loan: 'Sample Short-Term Loan',
  } : {}),
  savings_goal_1: 'Savings Goal 1',
  savings_goal_2: 'Savings Goal 2',
  community_pool: 'Community Pool Contributions',
  family_support: 'Family Support',
  home_project: 'Home Project',
  ...Object.fromEntries(Object.entries(VARIABLE)
    .filter(([key]) => !CATEGORY_ORDER.includes(key))
    .map(([key]) => [key, key.replace(/_/g, ' ')])),
  ...Object.fromEntries(accountData.debts.map(debt => [
    `${MANAGED_DEBT_PREFIX}${String(debt.id).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32)}`,
    debt.name,
  ])),
  ...Object.fromEntries(accountData.savings_goals.map(goal => [
    `${MANAGED_SAVINGS_PREFIX}${String(goal.id).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32)}`,
    goal.name,
  ])),
});

const getCurrentMonthKey = () => getScheduleStartMonth();
const getTodayDateKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const monthKeyFromDate = dateValue => dateValue.slice(0, 7);
const formatMonthKey = monthKey => {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
};
const readActualEntries = () => {
  const entries = isAccountMode ? accountData.actuals : [];
  if (!Array.isArray(entries)) {
    showToast('Saved actuals are invalid. Please reload your account data.', true);
    return [];
  }
  return entries.filter(entry => entry
      && typeof entry.id === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      && (entry.type === 'income' || entry.type === 'expense')
      && typeof entry.category === 'string'
      && Number.isFinite(Number(entry.amount))
      && Number(entry.amount) > 0);
};
const writeActualEntries = entries => {
  if (!isAccountMode) {
    showToast('Sign in to record actual transactions.', true);
    return false;
  }
  accountData.actuals = entries;
  queueAccountSave();
  return true;
};
const getActualCategories = (type) => {
  if (type === 'income') return [{ id: 'income:salary', label: 'Salary + allowances' }];
  const variableLabels = getVariableCategoryLabels();
  return [
    ...Object.entries(FIXED_DEF).map(([key, [label]]) => ({ id: `fixed:${key}`, label })),
    ...Object.keys(VARIABLE).map(key => ({ id: `variable:${key}`, label: variableLabels[key] || key.replace(/_/g, ' ') })),
  ];
};
const populateActualCategorySelect = () => {
  const type = document.getElementById('actual-type')?.value || 'expense';
  const select = document.getElementById('actual-category');
  if (!select) return;
  select.innerHTML = getActualCategories(type)
    .map(category => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.label)}</option>`)
    .join('');
};
const getPlanMonthIndex = monthKey => {
  const [year, month] = monthKey.split('-').map(Number);
  const now = new Date();
  return (year - now.getFullYear()) * 12 + month - 1 - now.getMonth();
};
const getPlanValuesByCategory = (planRow) => {
  if (!planRow) return [];
  const categories = [{ id: 'income:salary', label: 'Salary + allowances', type: 'income', amount: planRow.income }];
  Object.entries(planRow.fixed).forEach(([key, amount]) => {
    categories.push({ id: `fixed:${key}`, label: FIXED_DEF[key][0], type: 'expense', amount });
  });
  const variableLabels = getVariableCategoryLabels();
  Object.keys(VARIABLE).forEach((key) => {
    categories.push({
      id: `variable:${key}`,
      label: variableLabels[key] || key.replace(/_/g, ' '),
      type: 'expense',
      amount: VARIABLE[key][planRow.m] || 0,
    });
  });
  return categories;
};
const renderActuals = () => {
  const monthSelect = document.getElementById('actuals-month');
  if (!monthSelect) return;
  const monthKey = monthSelect.value || getCurrentMonthKey();
  const rows = compute();
  const planIndex = getPlanMonthIndex(monthKey);
  const planRow = planIndex >= 0 && planIndex < rows.length ? rows[planIndex] : null;
  const entries = readActualEntries().filter(entry => monthKeyFromDate(entry.date) === monthKey);
  const planCategories = getPlanValuesByCategory(planRow);
  const totals = {
    income: entries.filter(entry => entry.type === 'income').reduce((sum, entry) => sum + Number(entry.amount), 0),
    expenses: entries.filter(entry => entry.type === 'expense').reduce((sum, entry) => sum + Number(entry.amount), 0),
  };
  const planIncome = planRow?.income ?? null;
  const planExpenses = planRow?.exp ?? null;
  const summary = document.getElementById('actuals-summary');
  const comparison = document.getElementById('actuals-comparison');
  const periodNote = document.getElementById('actuals-period-note');
  if (periodNote) {
    periodNote.textContent = monthKey === getCurrentMonthKey()
      ? 'Current month actuals are month-to-date and are compared with the full-month plan. A positive expense difference means spending is over plan.'
      : planRow
        ? 'Actuals logged for this month are compared with the full-month plan. A positive expense difference means spending is over plan.'
        : 'No forecast plan exists for this month. You can still record and review actual transactions.';
  }
  if (summary) {
    const netVariance = planRow ? (totals.income - totals.expenses) - planRow.net : null;
    summary.innerHTML = [
      { label: 'Income logged', actual: totals.income, planned: planIncome, kind: 'income' },
      { label: 'Expenses logged', actual: totals.expenses, planned: planExpenses, kind: 'expense' },
      { label: 'Net vs plan', actual: totals.income - totals.expenses, planned: planRow?.net ?? null, variance: netVariance, kind: 'net' },
    ].map((item) => {
      const variance = item.variance ?? (item.planned === null ? null
        : item.kind === 'expense' ? item.actual - item.planned : item.actual - item.planned);
      return `<div class="actuals-summary-card ${item.kind}">
        <div class="actuals-summary-label">${item.label}</div>
        <div class="actuals-summary-value">${fmtK(item.actual)}</div>
        <div class="actuals-summary-note">${item.planned === null ? 'No plan for this month' : `Plan ${fmtK(item.planned)} · ${variance > 0 ? '+' : ''}${fmtK(variance)} vs plan`}</div>
      </div>`;
    }).join('');
  }
  if (comparison) {
    const actualById = new Map();
    entries.forEach((entry) => {
      const id = entry.category;
      actualById.set(id, (actualById.get(id) || 0) + Number(entry.amount));
    });
    const additional = entries.filter(entry => !planCategories.some(category => category.id === entry.category))
      .reduce((list, entry) => {
        const id = entry.category;
        if (!list.some(category => category.id === id)) {
          list.push({ id, label: entry.categoryLabel || entry.category, type: entry.type, amount: 0 });
        }
        return list;
      }, []);
    const allCategories = [...planCategories, ...additional];
    comparison.innerHTML = `<thead><tr><th>Category</th><th>Plan</th><th>Actual so far</th><th>Difference</th></tr></thead><tbody>${
      allCategories.map((category) => {
        const actual = actualById.get(category.id) || 0;
        const variance = actual - category.amount;
        const adverse = category.type === 'expense' ? variance > 0 : variance < 0;
        const favorable = category.type === 'expense' ? variance < 0 : variance > 0;
        return `<tr><td data-label="Category">${escapeHtml(category.label)}</td><td data-label="Plan">${planRow ? fmt(category.amount) : '—'}</td><td data-label="Actual so far">${fmt(actual)}</td><td data-label="Difference" class="${adverse ? 'cv-neg' : favorable ? 'cv-pos' : ''}">${planRow ? `${variance > 0 ? '+' : ''}${fmt(variance)}` : '—'}</td></tr>`;
      }).join('')
    }</tbody>`;
  }
  const entryList = document.getElementById('actuals-entries');
  if (entryList) {
    entryList.innerHTML = `<h3 class="actuals-entry-title">${entries.length ? `${entries.length} actual entr${entries.length === 1 ? 'y' : 'ies'} · ${formatMonthKey(monthKey)}` : `No actuals logged for ${formatMonthKey(monthKey)}`}</h3>${
      entries.length ? `<div class="actuals-entry-list">${[...entries].sort((a, b) => b.date.localeCompare(a.date)).map(entry => `
        <div class="actual-entry">
          <div class="actual-entry-main">
            <strong>${escapeHtml(entry.categoryLabel || entry.category)}</strong>
            <span>${escapeHtml(entry.date)} · ${entry.type === 'income' ? 'Income' : 'Expense'}${entry.note ? ` · ${escapeHtml(entry.note)}` : ''}</span>
          </div>
          <strong class="actual-entry-amount ${entry.type}">${entry.type === 'expense' ? '−' : '+'}${fmt(Number(entry.amount))}</strong>
          <button type="button" class="actual-delete" data-actual-delete="${escapeHtml(entry.id)}" aria-label="Delete ${escapeHtml(entry.categoryLabel || entry.category)} entry" ${isAccountMode ? '' : 'disabled'}>Delete</button>
        </div>`).join('')}</div>` : ''
    }`;
    entryList.querySelectorAll('[data-actual-delete]').forEach((button) => {
      button.addEventListener('click', () => {
        const remaining = readActualEntries().filter(entry => entry.id !== button.dataset.actualDelete);
        if (writeActualEntries(remaining)) {
          renderActuals();
        }
      });
    });
  }
  const actualDate = document.getElementById('actual-date');
  if (actualDate && monthKeyFromDate(actualDate.value || '') !== monthKey) {
    actualDate.value = `${monthKey}-01`;
  }
};
const addActualEntry = event => {
  event.preventDefault();
  if (!isAccountMode) {
    showToast('Sign in to record actuals.', true);
    return;
  }
  const date = document.getElementById('actual-date')?.value;
  const type = document.getElementById('actual-type')?.value;
  const category = document.getElementById('actual-category')?.value;
  const amount = Number(document.getElementById('actual-amount')?.value);
  const categoryOption = document.getElementById('actual-category')?.selectedOptions?.[0];
  if (!date || (type !== 'income' && type !== 'expense') || !category || !Number.isFinite(amount) || amount <= 0) {
    showToast('Enter a valid date, category, and positive amount.', true);
    return;
  }
  if (date > getTodayDateKey()) {
    showToast('Actual transaction dates cannot be in the future.', true);
    return;
  }
  if (monthKeyFromDate(date) !== document.getElementById('actuals-month')?.value) {
    showToast('Choose a transaction date within the selected month.', true);
    return;
  }
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    date,
    type,
    category,
    categoryLabel: categoryOption?.textContent || category,
    amount,
    note: document.getElementById('actual-note')?.value?.trim() || '',
  };
  if (!writeActualEntries([...readActualEntries(), entry])) return;
  document.getElementById('actual-amount').value = '';
  document.getElementById('actual-note').value = '';
  renderActuals();
};

const getScenarioStore = () => {
  if (isAccountMode) {
    if (Object.keys(accountData.scenarios).length) return accountData.scenarios;
    return { Current: accountData.plan || getCurrentPlanData() };
  }
  return {};
};

const saveScenarioStore = (scenarios) => {
  if (!isAccountMode) {
    showToast('Sign in to save scenarios.', true);
    return false;
  }
  accountData.scenarios = scenarios;
  queueAccountSave();
  return true;
};

const applyScenario = (name) => {
  const scenarios = getScenarioStore();
  const scenario = scenarios[name];
  if (!scenario) return false;
  if (scenario.forecastYears !== undefined && scenario.forecastYears !== null) {
    const scenarioYears = Number(scenario.forecastYears);
    if (!Number.isInteger(scenarioYears) || scenarioYears < 1 || scenarioYears > MAX_FORECAST_YEARS) {
      showToast('This scenario has an invalid forecast duration and cannot be applied.', true);
      return false;
    }
    setForecastDuration(scenarioYears);
  }
  if (Number.isFinite(Number(scenario.openingBalance))) openingBalance = Number(scenario.openingBalance);
  if (Number.isInteger(Number(scenario.payday))) payday = Math.min(31, Math.max(1, Number(scenario.payday)));
  if (scenario.fixedDueDays && typeof scenario.fixedDueDays === 'object') {
    Object.keys(FIXED_DEF).forEach((key) => {
      const day = Number(scenario.fixedDueDays[key]);
      if (Number.isInteger(day)) fixedDueDays[key] = Math.min(31, Math.max(1, day));
    });
  }
  if (scenario.variableDueDays && typeof scenario.variableDueDays === 'object') {
    Object.keys(VARIABLE).forEach((key) => {
      const day = Number(scenario.variableDueDays[key]);
      if (Number.isInteger(day)) variableDueDays[key] = Math.min(31, Math.max(1, day));
    });
  }
  if (scenario.income) {
    const salary = Number(scenario.income.salary);
    const cola = Number(scenario.income.cola);
    if (Number.isFinite(salary)) INCOME.salary = salary;
    if (Number.isFinite(cola)) INCOME.cola = cola;
  }
  Object.keys(FIXED_DEF).forEach((key) => {
    if (scenario.fixed && Number.isFinite(Number(scenario.fixed[key]))) {
      FIXED_DEF[key][1] = Number(scenario.fixed[key]);
    }
  });
  Object.keys(VARIABLE).forEach((key) => {
    if (scenario.variable && Array.isArray(scenario.variable[key])) {
      VARIABLE[key] = alignVariableSchedule(scenario.variable[key], scenario.scheduleStartMonth);
    }
  });
  if (isAccountMode) syncAccountEntitySchedules();
  initInputs();
  recompute({ notify: false });
  showToast(`Scenario “${name}” applied.`);
  return true;
};

const saveCurrentScenario = () => {
  if (!isAccountMode) {
    showToast('Sign in to save scenarios.', true);
    return;
  }
  const name = document.getElementById('new-scenario-name')?.value?.trim() || document.getElementById('scenario-select')?.value || 'Current';
  const scenarios = getScenarioStore();
  scenarios[name] = {
    forecastYears,
    income: { salary: getSalary(), cola: getCola() },
    fixed: { ...getFixed() },
    variable: Object.fromEntries(Object.entries(VARIABLE).map(([key, values]) => [key, [...values]])),
    openingBalance: getOpeningBalance(),
    payday: getPayday(),
    scheduleStartMonth: getScheduleStartMonth(),
    fixedDueDays: getFixedDueDays(),
    variableDueDays: getVariableDueDays(),
  };
  if (!saveScenarioStore(scenarios)) {
    showToast('Could not save this scenario to your account.', true);
    return;
  }
  populateScenarioControls();
  document.getElementById('scenario-select').value = name;
  document.getElementById('new-scenario-name').value = '';
  showToast(`Scenario “${name}” saved.`);
};

const populateScenarioControls = () => {
  const select = document.getElementById('scenario-select');
  const categorySelect = document.getElementById('category-select');
  if (!select) return;
  const scenarios = getScenarioStore();
  const names = Object.keys(scenarios);
  select.innerHTML = names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  const current = select.value || names[0];
  if (current && names.includes(current)) select.value = current;

  if (categorySelect) {
    const rowKeys = Object.keys(VARIABLE).filter((key) => typeof key === 'string');
    categorySelect.innerHTML = rowKeys.map((key) => `<option value="${key}">${key}</option>`).join('');
  }
};

const addCategory = () => {
  if (!isAccountMode) {
    showToast('Sign in to edit categories.', true);
    return;
  }
  const nameInput = document.getElementById('new-category-name');
  const name = nameInput?.value?.trim();
  if (!name || /[^a-zA-Z0-9_]/.test(name)) {
    alert('Use letters, numbers, or underscores only for category names.');
    return;
  }
  if (Object.prototype.hasOwnProperty.call(VARIABLE, name)) {
    alert('This category already exists.');
    return;
  }
  VARIABLE[name] = Array(MAX_NM).fill(0);
  FIXED_DEF[name] = [name.replace(/_/g, ' '), 0];
  if (nameInput) nameInput.value = '';
  populateScenarioControls();
  initInputs();
  renderCashflowFilters();
  recompute({ notify: false });
  showToast('Category added.');
};

const removeCategory = () => {
  if (!isAccountMode) {
    showToast('Sign in to edit categories.', true);
    return;
  }
  const select = document.getElementById('category-select');
  const key = select?.value;
  if (!key) return;
  if (!Object.prototype.hasOwnProperty.call(VARIABLE, key)) return;
  if (CATEGORY_ORDER.includes(key)) {
    alert('Built-in categories cannot be removed.');
    return;
  }
  delete VARIABLE[key];
  delete FIXED_DEF[key];
  populateScenarioControls();
  initInputs();
  renderCashflowFilters();
  recompute({ notify: false });
  showToast('Category removed.');
};

const hasPrivatePlanInputs = () => getSalary() > 0
  || getCola() > 0
  || getOpeningBalance() !== 0
  || accountData.debts.length > 0
  || accountData.savings_goals.length > 0
  || Object.values(getFixed()).some(amount => amount > 0)
  || Object.values(VARIABLE).some(values => values.some(amount => amount > 0));

export const recompute = ({ persist = true } = {}) => {
  if (!isAccountMode) {
    Object.keys(CHARTS).forEach(destroyChart);
    return;
  }
  const rows = compute();
  const emptyAccountPlan = isAccountMode && !hasPrivatePlanInputs();
  document.body.classList.toggle('account-plan-empty', emptyAccountPlan);
  renderPlanSummary(rows);
  renderCashRisk(rows);
  renderKPI(rows);
  renderAlerts(rows);
  renderInsights(rows);
  renderCFTable(rows);
  renderCharts(rows);
  renderDebts();
  renderSavings(rows);
  if (persist && isAccountMode) {
    saveCurrentPlan();
  }
};

const renderPlanSummary = (rows) => {
  const el = document.getElementById('plan-summary');
  if (!el) return;
  if (isAccountMode && !hasPrivatePlanInputs()) {
    el.innerHTML = `
      <div class="account-empty-state">
        <h2>Your private plan is ready to set up</h2>
        <p>This account starts with blank inputs. Sample figures are never copied into your plan.</p>
        <button class="btn-secondary" type="button">Enter my plan details</button>
      </div>
    `;
    el.querySelector('button')?.addEventListener('click', () => {
      showTab('inputs', document.getElementById('tab-button-inputs'));
    });
    return;
  }

  const netPeriod = rows.reduce((s, r) => s + r.net, 0);
  const deficitMonths = rows.filter(r => r.minBalance < 0).length;
  const lastMonth = rows.at(-1);
  const lowestPoint = rows.reduce((lowest, row) => row.minBalance < lowest.minBalance ? row : lowest, rows[0]);
  const rentTarget = SAVINGS_GOALS.find(g => g.key === '__rent__')?.target || 851000;
  const rentProjected = [...(VARIABLE.savings_goal_1 || []), ...(VARIABLE.savings_goal_2 || [])]
    .reduce((sum, value) => sum + value, 0);
  const gap = isAccountMode ? 0 : rentTarget - rentProjected;
  const health = deficitMonths === 0 && netPeriod >= 0 && gap <= 0 ? 'On track' : deficitMonths <= 2 ? 'Needs attention' : 'High risk';

  el.innerHTML = `
    <div class="plan-summary__badge ${health === 'On track' ? 'good' : health === 'Needs attention' ? 'warn' : 'bad'}">${health}</div>
    <div class="plan-summary__content">
      <div class="plan-summary__title">Plan health</div>
      <div class="plan-summary__value">${fmtK(netPeriod)}</div>
      <div class="plan-summary__meta">
        ${deficitMonths} month${deficitMonths === 1 ? '' : 's'} below zero · lowest cash ${fmtK(lowestPoint.minBalance)} on ${fmtDate(lowestPoint.minDate)} · end balance ${fmtK(lastMonth?.cum || 0)}
      </div>
    </div>
  `;
};

const renderCashRisk = (rows) => {
  const el = document.getElementById('cash-risk');
  if (!el) return;
  const deficits = rows.filter(row => row.minBalance < 0);
  const lowest = rows.reduce((current, row) => row.minBalance < current.minBalance ? row : current, rows[0]);
  const rowsHtml = deficits.map((row) => {
    const obligations = row.events
      .filter(event => event.kind === 'expense' && event.date <= row.minDate)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3)
      .map(event => `${escapeHtml(event.label)} (${fmtK(Math.abs(event.amount))})`)
      .join(', ');
    return `<tr>
      <td data-label="Month">${escapeHtml(row.month)}</td>
      <td data-label="Lowest point">${fmtDate(row.minDate)}</td>
      <td data-label="Balance">${fmtK(row.minBalance)}</td>
      <td data-label="Largest scheduled outflows" class="cash-risk__obligations">${obligations || 'No scheduled expense identified before this point'}</td>
    </tr>`;
  }).join('');

  el.classList.toggle('has-deficit', deficits.length > 0);
  el.innerHTML = deficits.length
    ? `<div class="cash-risk__title">Projected cash shortfall</div>
       <p class="cash-risk__note">The dated plan reaches a negative balance in ${deficits.length} month${deficits.length === 1 ? '' : 's'}. Review the listed obligations and adjust their amount, timing, or scenario.</p>
       <div class="cash-risk__table-wrap"><table class="cash-risk__table">
         <thead><tr><th>Month</th><th>Lowest point</th><th>Balance</th><th>Largest scheduled outflows by then</th></tr></thead>
         <tbody>${rowsHtml}</tbody>
       </table></div>
       <p class="cash-risk__assumption">Estimate only, not financial advice. Salary and allowances are assumed to arrive together. Scheduled outflows are counted before income if they fall on the same day.</p>`
    : `<div class="cash-risk__title">No projected cash shortfall</div>
       <p class="cash-risk__note">Lowest projected cash is ${fmtK(lowest.minBalance)} on ${fmtDate(lowest.minDate)}. This forecast depends on the opening balance, payday, and payment dates entered.</p>
       <p class="cash-risk__assumption">Estimate only, not financial advice. Salary and allowances are assumed to arrive together. Scheduled outflows are counted before income if they fall on the same day.</p>`;
};

// ── KPI CARDS ─────────────────────────────────────────────
const renderKPI = (rows) => {
  const el = document.getElementById('kpi-grid');
  if (!el) return;

  const worstR   = rows.reduce((a, b) => (a.net < b.net ? a : b));
  const bestR    = rows.reduce((a, b) => (a.net > b.net ? a : b));
  const lowestR  = rows.reduce((a, b) => (a.minBalance < b.minBalance ? a : b));
  const rentProj = [...(VARIABLE.savings_goal_1 || []), ...(VARIABLE.savings_goal_2 || [])]
    .reduce((sum, amount) => sum + amount, 0);
  const rentTarget = SAVINGS_GOALS.find(g => g.key === '__rent__')?.target || 851000;
  const cards = isAccountMode ? [
    { l: 'Monthly Income', v: fmtK(rows[0].income), s: 'Salary + allowances', t: 'k-inf', c: 'c-inf' },
    { l: 'Lowest Cash Point', v: fmtK(lowestR.minBalance), s: `${fmtDate(lowestR.minDate)} · ${lowestR.month}`, t: lowestR.minBalance >= 0 ? 'k-pos' : 'k-neg', c: lowestR.minBalance >= 0 ? 'c-pos' : 'c-neg' },
    { l: 'Total Debt Balance', v: fmtK(accountData.debts.reduce((sum, debt) => sum + debt.balance, 0)), s: `${accountData.debts.length} private debt${accountData.debts.length === 1 ? '' : 's'}`, t: accountData.debts.length ? 'k-neg' : 'k-inf', c: accountData.debts.length ? 'c-neg' : 'c-inf' },
    { l: 'Savings Goals', v: fmtK(accountData.savings_goals.reduce((sum, goal) => sum + goal.saved_amount, 0)), s: `${accountData.savings_goals.length} goal${accountData.savings_goals.length === 1 ? '' : 's'} · current savings`, t: 'k-pos', c: 'c-pos' },
    { l: 'Best Month', v: fmtK(bestR.net), s: bestR.month + ' — surplus', t: 'k-pos', c: 'c-pos' },
    { l: 'Worst Month', v: fmtK(Math.abs(worstR.net)), s: worstR.month + (worstR.net < 0 ? ' — deficit' : ' — surplus'), t: worstR.net < 0 ? 'k-neg' : 'k-pos', c: worstR.net < 0 ? 'c-neg' : 'c-pos' },
  ] : [
    { l: 'Monthly Income',   v: fmtK(rows[0].income),        s: 'Salary + COLA',                                            t: 'k-inf', c: 'c-inf' },
    { l: 'Lowest Cash Point',v: fmtK(lowestR.minBalance),     s: `${fmtDate(lowestR.minDate)} · ${lowestR.month}`,             t: lowestR.minBalance >= 0 ? 'k-pos' : 'k-neg', c: lowestR.minBalance >= 0 ? 'c-pos' : 'c-neg' },
    { l: 'Total Active Debt',v: fmtK(DEBTS.filter(d => d.status !== 'settled').reduce((s, d) => s + d.balance, 0)), s: 'Sample loans and other balances', t: 'k-neg', c: 'c-neg' },
    { l: 'Home Fund',        v: fmtK(rentProj),               s: `Target ${fmtK(rentTarget)} · ${rentProj >= rentTarget ? '✅ On track' : '⚠ Check plan'}`, t: rentProj >= rentTarget ? 'k-pos' : 'k-warn', c: rentProj >= rentTarget ? 'c-pos' : 'c-warn' },
    { l: 'Best Month',       v: fmtK(bestR.net),              s: bestR.month + ' — surplus',                                t: 'k-pos', c: 'c-pos' },
    { l: 'Worst Month',      v: fmtK(Math.abs(worstR.net)),   s: worstR.month + (worstR.net < 0 ? ' — deficit' : ' — surplus'), t: worstR.net < 0 ? 'k-neg' : 'k-pos', c: worstR.net < 0 ? 'c-neg' : 'c-pos' },
  ];

  el.innerHTML = cards.map(c => `
    <div class="kpi ${c.t}">
      <div class="kpi-l">${c.l}</div>
      <div class="kpi-v ${c.c}">${c.v}</div>
      <div class="kpi-s">${c.s}</div>
    </div>`).join('');
};

// ── ALERT CHIPS ────────────────────────────────────────────
const renderAlerts = (rows) => {
  const el = document.getElementById('alert-row');
  if (!el) return;
  const alerts = [];

  const deficits = rows.filter(r => r.minBalance < 0);
  if (deficits.length) {
    alerts.push({ t: 'bad', txt: `⚠ Cash is projected to go negative in ${deficits.map(r => `${r.month} (${fmtDate(r.minDate)})`).join(', ')}` });
  }
  const monthlyDeficits = rows.filter(r => r.net < 0);
  if (monthlyDeficits.length) {
    alerts.push({ t: 'warn', txt: `${monthlyDeficits.length} month${monthlyDeficits.length > 1 ? 's' : ''} have more planned outflow than income` });
  }
  if (isAccountMode) {
    el.innerHTML = alerts.map(a => `<div class="chip ${a.t}">${a.txt}</div>`).join('');
    return;
  }
  const homeProjectRisk = rows.find(row => row.net < -500000 && (VARIABLE.home_project?.[row.m] || 0) > 0);
  if (homeProjectRisk) {
    alerts.push({ t: 'bad', txt: `🏡 ${homeProjectRisk.month}: large planned home-project payment — build a cash buffer` });
  }
  const rentTotal = VARIABLE.savings_goal_1.reduce((s, v) => s + v, 0)
                  + VARIABLE.savings_goal_2.reduce((s, v) => s + v, 0);
  const rentTarget = SAVINGS_GOALS.find(g => g.key === '__rent__')?.target || 851000;
  if (rentTotal >= rentTarget) {
    alerts.push({ t: 'ok', txt: `🏡 Home fund on track — ${fmtK(rentTotal)} projected vs ${fmtK(rentTarget)} target` });
  } else {
    alerts.push({ t: 'warn', txt: `🏡 Home fund: ${fmtK(rentTotal)} projected, ${fmtK(rentTarget - rentTotal)} short of target` });
  }
  const negotiation = DEBTS.find(d => d.status === 'negotiating');
  if (negotiation) {
    alerts.push({ t: 'warn', txt: '💳 Sample debt settlement is under review — verify terms before committing' });
  }

  el.innerHTML = alerts.map(a => `<div class="chip ${a.t}">${a.txt}</div>`).join('');
};

const renderInsights = (rows) => {
  const el = document.getElementById('insights-grid');
  if (!el) return;

  const worstMonth = rows.reduce((worst, current) => current.minBalance < worst.minBalance ? current : worst, rows[0]);
  const bestMonth = rows.reduce((best, current) => current.net > best.net ? current : best, rows[0]);
  const avgNet = rows.reduce((s, row) => s + row.net, 0) / rows.length;
  const netPeriod = rows.reduce((s, row) => s + row.net, 0);
  if (isAccountMode) {
    const ideas = [
      { label: 'End-of-period cash', value: fmtK(rows.at(-1).cum), note: `${fmtK(avgNet)} average monthly cash flow`, tone: avgNet >= 0 ? 'good' : 'warn' },
      { label: 'Lowest cash point', value: worstMonth.month, note: `${fmtK(worstMonth.minBalance)} · ${fmtDate(worstMonth.minDate)}`, tone: worstMonth.minBalance < 0 ? 'bad' : 'good' },
      { label: 'Period result', value: netPeriod >= 0 ? 'Surplus' : 'Deficit', note: `${fmtK(Math.abs(netPeriod))} ${netPeriod >= 0 ? 'positive' : 'negative'} over the period`, tone: netPeriod >= 0 ? 'good' : 'bad' },
    ];
    el.innerHTML = ideas.map(idea => `
      <div class="insight ${idea.tone}">
        <div class="insight__label">${idea.label}</div>
        <div class="insight__value">${idea.value}</div>
        <div class="insight__note">${idea.note}</div>
      </div>
    `).join('');
    return;
  }
  const rentTarget = SAVINGS_GOALS.find(g => g.key === '__rent__')?.target || 851000;
  const rentProjected = VARIABLE.savings_goal_1.reduce((s, v) => s + v, 0) + VARIABLE.savings_goal_2.reduce((s, v) => s + v, 0);
  const debtTarget = DEBTS.filter(d => d.status !== 'settled').reduce((s, d) => s + d.opening, 0);

  const ideas = [
    {
      label: 'End-of-period cash',
      value: fmtK(rows.at(-1).cum),
      note: `${avgNet >= 0 ? 'Healthy monthly average' : 'Average negative cash flow'} · ${fmtK(avgNet)} / month`,
      tone: avgNet >= 0 ? 'good' : 'warn',
    },
    {
      label: 'Biggest risk',
      value: worstMonth.month,
      note: `${fmtK(worstMonth.minBalance)} lowest balance · ${fmtDate(worstMonth.minDate)}`,
      tone: 'bad',
    },
    {
      label: 'Priority move',
      value: rentProjected >= rentTarget ? 'On track' : 'Build buffer',
      note: `${fmtK(Math.max(0, rentTarget - rentProjected))} left to hit rent target`,
      tone: rentProjected >= rentTarget ? 'good' : 'warn',
    },
    {
      label: 'Period result',
      value: netPeriod >= 0 ? 'Surplus' : 'Deficit',
      note: `${fmtK(Math.abs(netPeriod))} ${netPeriod >= 0 ? 'positive' : 'negative'} over the period`,
      tone: netPeriod >= 0 ? 'good' : 'bad',
    },
    {
      label: 'Best month',
      value: bestMonth.month,
      note: `${fmtK(bestMonth.net)} strongest cash position`,
      tone: 'good',
    },
    {
      label: 'Debt base',
      value: fmtK(debtTarget),
      note: 'Total opening debt load before payoff',
      tone: 'warn',
    },
  ];

  el.innerHTML = ideas.map((idea) => `
    <div class="insight ${idea.tone}">
      <div class="insight__label">${idea.label}</div>
      <div class="insight__value">${idea.value}</div>
      <div class="insight__note">${idea.note}</div>
    </div>
  `).join('');
};

// ── CASH FLOW TABLE ────────────────────────────────────────
const getHiddenCashflowCategories = () => {
  try {
    const raw = localStorage.getItem(CASHFLOW_HIDDEN_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch (err) {
    return new Set();
  }
};

const setHiddenCashflowCategories = (hidden) => {
  try {
    localStorage.setItem(CASHFLOW_HIDDEN_KEY, JSON.stringify([...hidden]));
  } catch (err) {
    // Ignore storage access failures.
  }
};

const renderCashflowFilters = () => {
  const el = document.getElementById('cashflow-filters');
  if (!el) return;
  const hidden = getHiddenCashflowCategories();
  const variableLabels = getVariableCategoryLabels();
  const items = [
    ...Object.keys(VARIABLE).map((key) => ({ key, label: variableLabels[key] || key.replace(/_/g, ' ') })),
    ...Object.keys(FIXED_DEF).map((key) => ({ key: `fixed:${key}`, label: FIXED_DEF[key][0] })),
  ];

  el.innerHTML = items.map(({ key, label }) => {
    const checked = !hidden.has(key);
    return `
      <label class="visibility-toggle">
        <input type="checkbox" data-cashflow-toggle="${key}" ${checked ? 'checked' : ''}>
        <span>${label}</span>
      </label>
    `;
  }).join('');

  el.querySelectorAll('[data-cashflow-toggle]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const target = event.currentTarget;
      const key = target.getAttribute('data-cashflow-toggle');
      const hiddenSet = getHiddenCashflowCategories();
      if (target.checked) hiddenSet.delete(key);
      else hiddenSet.add(key);
      setHiddenCashflowCategories(hiddenSet);
      renderCFTable(compute());
      showToast('Cash-flow category visibility updated.');
    });
  });
};

const renderCFTable = (rows) => {
  const tbl = document.getElementById('cf-table');
  if (!tbl) return;
  const hidden = getHiddenCashflowCategories();
  const narrowScreen = window.matchMedia('(max-width: 640px)').matches;
  const monthSelect = document.getElementById('cashflow-month');
  const selectedMonth = Number(monthSelect?.value);
  const visibleIndexes = narrowScreen
    ? [Number.isInteger(selectedMonth) ? Math.min(Math.max(selectedMonth, 0), MONTHS.length - 1) : 0]
    : MONTHS.map((_, index) => index);

  const row = (label, vals, cls = '', colCls = null) => {
    const cells = visibleIndexes.map(index => {
      const value = vals[index];
      return `<td class="${colCls ? colCls(value) : ''}">${fmt(value)}</td>`;
    }).join('');
    return `<tr class="${cls}"><td class="col-label">${label}</td>${cells}</tr>`;
  };
  const cat = (label) =>
    `<tr class="r-cat"><td class="col-label">${label}</td>${visibleIndexes.map(() => '<td></td>').join('')}</tr>`;

  let h = `<thead><tr>
    <th class="col-label">Category</th>
    ${visibleIndexes.map(index => `<th>${narrowScreen ? 'Amount' : MONTHS[index]}</th>`).join('')}
  </tr></thead><tbody>`;

  h += row('📥 Total Income', rows.map(r => r.income), 'r-income');

  if (isAccountMode) {
    if (!hasPrivatePlanInputs()) {
      h += `<tr><td class="col-label" colspan="${visibleIndexes.length + 1}">Add your own income and expenses in Edit Inputs to build your private cash-flow forecast.</td></tr>`;
    } else {
      Object.keys(VARIABLE).forEach((key) => {
        if (!hidden.has(key)) {
          h += row(getVariableCategoryLabels()[key] || key.replace(/_/g, ' '), rows.map(r => VARIABLE[key][r.m] || 0), '', value => value > 0 ? 'cv-neg' : 'cv-zero');
        }
      });
      Object.entries(FIXED_DEF).forEach(([key, [label]]) => {
        if (rows[0].fixed[key] > 0 && !hidden.has(`fixed:${key}`)) {
          h += row(label, rows.map(() => rows[0].fixed[key]), '', () => 'cv-zero');
        }
      });
    }
    h += row('📤 Total Expenses', rows.map(r => r.exp), 'r-texp');
    h += row('⚡ Net Surplus / Deficit', rows.map(r => r.net), 'r-net', value => value >= 0 ? 'cv-pos' : 'cv-neg');
    h += row('📈 End-of-Month Balance', rows.map(r => r.cum), 'r-cum', value => value >= 0 ? 'cv-pos' : 'cv-neg');
    tbl.innerHTML = `${h}</tbody>`;
    return;
  }

  h += cat('Debt Obligations');
  if (VARIABLE.loan_bundle && !hidden.has('loan_bundle')) h += row('Sample Loans A + B', rows.map(r => VARIABLE.loan_bundle[r.m] || 0), '', v => v > 0 ? 'cv-neg' : 'cv-zero');
  if (VARIABLE.short_term_loan && !hidden.has('short_term_loan')) h += row('Sample Short-Term Loan', rows.map(r => VARIABLE.short_term_loan[r.m] || 0), '', v => v > 0 ? 'cv-neg' : 'cv-zero');

  h += cat('Savings & Investments');
  if (VARIABLE.savings_goal_1 && !hidden.has('savings_goal_1')) h += row('Savings Goal 1', rows.map(r => VARIABLE.savings_goal_1[r.m] || 0), '', v => v > 0 ? 'cv-neg' : 'cv-zero');
  if (VARIABLE.savings_goal_2 && !hidden.has('savings_goal_2')) h += row('Savings Goal 2', rows.map(r => VARIABLE.savings_goal_2[r.m] || 0), '', v => v > 0 ? 'cv-neg' : 'cv-zero');
  if (VARIABLE.community_pool && !hidden.has('community_pool')) h += row('Community Pool Contributions', rows.map(r => VARIABLE.community_pool[r.m] || 0), '', v => v > 0 ? 'cv-neg' : 'cv-zero');

  h += cat('Family & Home Project');
  if (VARIABLE.family_support && !hidden.has('family_support')) h += row('Family Support', rows.map(r => VARIABLE.family_support[r.m] || 0), '', v => v > 0 ? 'cv-neg' : 'cv-zero');
  if (VARIABLE.home_project && !hidden.has('home_project')) h += row('Home Project', rows.map(r => VARIABLE.home_project[r.m] || 0), '', v => v > 0 ? 'cv-neg' : 'cv-zero');

  const customVariables = Object.keys(VARIABLE).filter(key => !CATEGORY_ORDER.includes(key));
  if (customVariables.length) {
    h += cat('Other Variable Expenses');
    customVariables.forEach((key) => {
      if (!hidden.has(key)) {
        h += row(getVariableCategoryLabels()[key], rows.map(r => VARIABLE[key][r.m] || 0), '', v => v > 0 ? 'cv-neg' : 'cv-zero');
      }
    });
  }

  h += cat('Living Expenses');
  const fixed = rows[0].fixed;
  Object.entries(FIXED_DEF).forEach(([k, [label]]) => {
    if (fixed[k] > 0 && !hidden.has(`fixed:${k}`)) h += row(label, rows.map(() => fixed[k]), '', () => 'cv-zero');
  });

  h += row('📤 Total Expenses', rows.map(r => r.exp), 'r-texp');
  h += row('⚡ Net Surplus / Deficit', rows.map(r => r.net), 'r-net', v => v >= 0 ? 'cv-pos' : 'cv-neg');
  h += row('📈 End-of-Month Balance', rows.map(r => r.cum), 'r-cum', v => v >= 0 ? 'cv-pos' : 'cv-neg');
  h += '</tbody>';

  tbl.innerHTML = h;
};

// ── CHARTS ─────────────────────────────────────────────────
const renderCharts = (rows) => {
  const chartIds = ['chart-net', 'chart-cum', 'chart-pie', 'chart-debts', 'chart-savings'];
  const debtCanvas = document.getElementById('chart-debts');
  const debtEmptyState = document.getElementById('debt-chart-empty-state');
  const savingsCanvas = document.getElementById('chart-savings');
  const savingsEmptyState = document.getElementById('savings-chart-empty-state');
  const privateDebts = isAccountMode ? accountData.debts : [];
  const privateGoals = isAccountMode ? accountData.savings_goals : [];
  if (debtCanvas) debtCanvas.hidden = isAccountMode && !privateDebts.length;
  if (debtEmptyState) debtEmptyState.hidden = !isAccountMode || privateDebts.length > 0;
  if (savingsCanvas) savingsCanvas.hidden = isAccountMode && !privateGoals.length;
  if (savingsEmptyState) savingsEmptyState.hidden = !isAccountMode || privateGoals.length > 0;
  if (isAccountMode && !hasPrivatePlanInputs()) {
    chartIds.forEach(destroyChart);
    return;
  }
  const { grid, tick } = gc();
  const nets = rows.map(r => r.net);
  const cums = rows.map(r => r.minBalance);

  // Shared scale options
  const scales = () => ({
    x: { grid: { color: grid }, ticks: { color: tick, font: { size: 10 } } },
    y: { grid: { color: grid }, ticks: { color: tick, font: { size: 10 }, callback: v => fmtK(v) } },
  });

  // 1. Net cash flow bar chart
  destroyChart('chart-net');
  const c1 = document.getElementById('chart-net');
  if (c1) {
    charts['chart-net'] = new Chart(c1, {
      type: 'bar',
      data: {
        labels: MONTHS,
        datasets: [{
          data: nets,
          backgroundColor: nets.map(v => v >= 0 ? 'rgba(26,188,156,.65)' : 'rgba(192,57,43,.65)'),
          borderColor:      nets.map(v => v >= 0 ? BRAND.teal : BRAND.red),
          borderWidth: 1, borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmt(c.raw) } } },
        scales: scales(),
      },
    });
  }

  // 2. Cumulative line chart
  destroyChart('chart-cum');
  const c2 = document.getElementById('chart-cum');
  if (c2) {
    charts['chart-cum'] = new Chart(c2, {
      type: 'line',
      data: {
        labels: MONTHS,
        datasets: [{
          data: cums,
          borderColor: BRAND.teal, backgroundColor: 'rgba(26,188,156,.08)',
          borderWidth: 2.5, fill: true, tension: .35,
          pointBackgroundColor: cums.map(v => v >= 0 ? BRAND.teal : BRAND.red),
          pointRadius: 4, pointHoverRadius: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmt(c.raw) } } },
        scales: scales(),
      },
    });
  }

  // 3. Expense breakdown doughnut
  destroyChart('chart-pie');
  const c3 = document.getElementById('chart-pie');
  if (c3) {
    if (isAccountMode) {
      const categories = [
        ...Object.entries(FIXED_DEF)
          .filter(([key]) => rows[0].fixed[key] > 0)
          .map(([key, [label]]) => ({
            label,
            total: rows.reduce((sum, row) => sum + (row.fixed[key] || 0), 0),
          })),
        ...Object.keys(VARIABLE).map(key => ({
          label: getVariableCategoryLabels()[key] || key.replace(/_/g, ' '),
          total: rows.reduce((sum, row) => sum + (VARIABLE[key][row.m] || 0), 0),
        })).filter(category => category.total > 0),
      ];
      const surplus = Math.max(0, rows.reduce((sum, row) => sum + row.net, 0));
      if (surplus > 0) categories.push({ label: 'Net Surplus', total: surplus });
      charts['chart-pie'] = new Chart(c3, {
        type: 'doughnut',
        data: {
          labels: categories.map(category => category.label),
          datasets: [{
            data: categories.map(category => category.total),
            backgroundColor: categories.map((_, index) => `hsl(${(index * 67 + 190) % 360} 55% 55%)`),
            borderWidth: 2,
            borderColor: isDark() ? '#18242F' : '#fff',
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right', labels: { color: tick, font: { size: 10 }, boxWidth: 12 } },
            tooltip: { callbacks: { label: c => `${c.label}: ${fmtK(c.raw)}` } },
          },
        },
      });
    } else {
    const debtT  = rows.reduce((s, r) => s + VARIABLE.loan_bundle[r.m] + VARIABLE.short_term_loan[r.m], 0);
    const savT   = rows.reduce((s, r) => s + VARIABLE.savings_goal_1[r.m] + VARIABLE.savings_goal_2[r.m] + VARIABLE.community_pool[r.m], 0);
    const famT   = rows.reduce((s, r) => s + VARIABLE.family_support[r.m] + VARIABLE.home_project[r.m], 0);
    const livT   = rows.reduce((s, r) => s + r.fixedSum, 0);
    const surpT  = Math.max(0, rows.reduce((s, r) => s + r.net, 0));
    const customVariables = Object.keys(VARIABLE).filter(key => !CATEGORY_ORDER.includes(key));

    charts['chart-pie'] = new Chart(c3, {
      type: 'doughnut',
      data: {
        labels: ['Debt Repayment', 'Savings', 'Family + Home', 'Living', ...customVariables.map(key => getVariableCategoryLabels()[key]), 'Net Surplus'],
        datasets: [{
          data: [
            debtT,
            savT,
            famT,
            livT - customVariables.reduce((sum, key) => sum + rows.reduce((s, r) => s + (r.fixed[key] || 0), 0), 0),
            ...customVariables.map(key => rows.reduce((sum, r) => sum + (VARIABLE[key][r.m] || 0) + (r.fixed[key] || 0), 0)),
            surpT,
          ],
          backgroundColor: [
            BRAND.red, BRAND.teal, BRAND.gold, BRAND.grey,
            ...customVariables.map((_, index) => `hsl(${(index * 67 + 190) % 360} 55% 55%)`),
            BRAND.navy,
          ],
          borderWidth: 2, borderColor: isDark() ? '#18242F' : '#fff',
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: tick, font: { size: 10 }, boxWidth: 12 } },
          tooltip: { callbacks: { label: c => `${c.label}: ${fmtK(c.raw)}` } },
        },
      },
    });
    }
  }

  // 4. Debt paydown line chart (Debts tab)
  destroyChart('chart-debts');
  const cd = document.getElementById('chart-debts');
  if (cd && isAccountMode && privateDebts.length) {
    const datasets = privateDebts.map((debt, index) => {
      const { balances } = makeDebtProjection(debt);
      return {
        label: debt.name,
        data: balances,
        borderColor: `hsl(${(index * 67 + 5) % 360} 65% 52%)`,
        borderWidth: 2.5,
        tension: .1,
        fill: false,
        pointRadius: 2,
      };
    });
    charts['chart-debts'] = new Chart(cd, {
      type: 'line',
      data: { labels: MONTHS, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: tick, font: { size: 11 }, boxWidth: 10 } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)}` } },
        },
        scales: scales(),
      },
    });
  } else if (cd && !isAccountMode) {
    const loanA = DEBTS.find(d => d.name.includes('Loan A'));
    const loanB = DEBTS.find(d => d.name.includes('Loan B'));
    const loanABalances = [], loanBBalances = [];
    if (loanA && loanB) {
      let loanABalance = loanA.balance;
      let loanBBalance = loanB.balance;
      for (let m = 0; m < NM; m++) {
        loanABalances.push(Math.round(loanABalance));
        loanBBalances.push(Math.round(loanBBalance));

        const totalPayment = Math.max(0, VARIABLE.loan_bundle[m] || 0);
        const loanAInterest = loanABalance * loanA.rate_pa / 100 / 12;
        const loanBInterest = loanBBalance * loanB.rate_pa / 100 / 12;
        const loanADue = loanABalance + loanAInterest;
        const loanBDue = loanBBalance + loanBInterest;
        const loanBPayment = Math.min(totalPayment, loanB.monthly, loanBDue);
        const remainingPayment = totalPayment - loanBPayment;
        const loanAPayment = Math.min(remainingPayment, loanADue);

        loanABalance = Math.max(0, loanADue - loanAPayment);
        loanBBalance = Math.max(0, loanBDue - loanBPayment - (remainingPayment - loanAPayment));
      }
    }
    charts['chart-debts'] = new Chart(cd, {
      type: 'line',
      data: {
        labels: MONTHS,
        datasets: [
          { label: 'Loan A', data: loanABalances, borderColor: BRAND.red,  backgroundColor: 'rgba(192,57,43,.05)',  borderWidth: 2.5, tension: .1, fill: false, pointRadius: 3 },
          { label: 'Loan B', data: loanBBalances, borderColor: BRAND.gold, backgroundColor: 'rgba(243,156,18,.05)', borderWidth: 2.5, tension: .1, fill: false, pointRadius: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: tick, font: { size: 11 }, boxWidth: 10 } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)}` } },
        },
        scales: scales(),
      },
    });
  }

  // 5. Savings accumulation line chart (Savings tab)
  destroyChart('chart-savings');
  const cs = document.getElementById('chart-savings');
  if (cs && isAccountMode && privateGoals.length) {
    const datasets = privateGoals.map((goal, index) => {
      let balance = goal.saved_amount;
      const balances = [];
      for (let month = 0; month < NM; month++) {
        balance += Math.min(goal.monthly_contribution, Math.max(0, goal.target_amount - balance));
        balances.push(balance);
      }
      return {
        label: goal.name,
        data: balances,
        borderColor: `hsl(${(index * 67 + 165) % 360} 55% 45%)`,
        borderWidth: 2.5,
        tension: .2,
        fill: false,
        pointRadius: 2,
      };
    });
    charts['chart-savings'] = new Chart(cs, {
      type: 'line',
      data: { labels: MONTHS, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: tick, font: { size: 11 }, boxWidth: 10 } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)}` } },
        },
        scales: scales(),
      },
    });
  } else if (cs && !isAccountMode) {
    let a1 = 0, a2 = 0;
    const d1 = [], d2 = [], combo = [];
    for (let m = 0; m < NM; m++) {
      a1 += VARIABLE.savings_goal_1[m];
      a2 += VARIABLE.savings_goal_2[m];
      d1.push(a1); d2.push(a2); combo.push(a1 + a2);
    }
    charts['chart-savings'] = new Chart(cs, {
      type: 'line',
      data: {
        labels: MONTHS,
        datasets: [
          { label: 'Savings Goal 1', data: d1,    borderColor: BRAND.teal, borderWidth: 2,   tension: .2, fill: false, pointRadius: 3 },
          { label: 'Savings Goal 2', data: d2,    borderColor: BRAND.gold, borderWidth: 2,   tension: .2, fill: false, pointRadius: 3 },
          { label: 'Combined',         data: combo, borderColor: BRAND.navy, borderWidth: 2.5, tension: .2, fill: false, pointRadius: 3, borderDash: [5, 3] },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: tick, font: { size: 11 }, boxWidth: 10 } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)}` } },
        },
        scales: scales(),
      },
    });
  }
};

// alias for inline chart re-use (window-scope below)
const charts = CHARTS;

// ── DEBTS TAB ──────────────────────────────────────────────
const renderDebts = () => {
  const el = document.getElementById('debt-list');
  if (!el) return;
  if (isAccountMode) {
    if (!accountData.debts.length) {
      el.innerHTML = '<div class="account-empty-state"><h2>No private debt entries</h2><p>Add a debt below to track its current balance and estimated monthly paydown. Sample debts are never copied into your account.</p></div>';
      return;
    }
    el.innerHTML = accountData.debts.map((debt) => `
      <article class="private-record">
        <h3>${escapeHtml(debt.name)}</h3>
        <p class="private-record-meta">Current balance: ${fmt(debt.balance)} · ${Number(debt.annual_interest_rate).toLocaleString()}% annual interest · ${fmt(debt.monthly_payment)} monthly payment · due day ${debt.due_day}</p>
        <form class="private-record-form" data-debt-form="${escapeHtml(debt.id)}">
          <label class="field">Debt name<input class="text-input" name="name" type="text" maxlength="80" value="${escapeHtml(debt.name)}" required></label>
          <label class="field">Current balance (₦)<input class="text-input" name="balance" type="number" min="0" max="1000000000000" step="1" value="${debt.balance}" required></label>
          <label class="field">Annual interest rate (%)<input class="text-input" name="annual_interest_rate" type="number" min="0" max="100" step="0.01" value="${debt.annual_interest_rate}" required></label>
          <label class="field">Monthly payment (₦)<input class="text-input" name="monthly_payment" type="number" min="0" max="1000000000000" step="1" value="${debt.monthly_payment}" required></label>
          <label class="field">Due day (1–31)<input class="text-input" name="due_day" type="number" min="1" max="31" step="1" value="${debt.due_day}" required></label>
          <div class="private-record-actions">
            <button class="btn-secondary" type="submit">Save changes</button>
            <button class="actual-delete danger" type="button" data-debt-delete="${escapeHtml(debt.id)}">Delete</button>
          </div>
        </form>
      </article>
    `).join('');
    return;
  }

  // Advance balances one month from opening (show Dec 26 state)
  const advanced = DEBTS.map(d => {
    if (d.rate_pa === 0 || d.monthly === 0) return { ...d, currentBal: d.balance };
    const rate = d.rate_pa / 100 / 12;
    const interest = d.balance * rate;
    const principal = d.monthly - interest;
    return { ...d, currentBal: Math.max(0, Math.round(d.balance - principal)) };
  });

  el.innerHTML = advanced.map(d => {
    const pct = Math.min(100, (1 - d.currentBal / d.opening) * 100);
    const col = d.status === 'negotiating' ? 'var(--gold)' : 'var(--teal)';
    return `<div class="dcard ${d.status === 'negotiating' ? 'neg' : d.status === 'settled' ? 'ok' : ''}">
      <div class="dname">${d.name}</div>
      <div class="dmeta">${d.note}</div>
      <div class="dbal">${fmt(d.currentBal)}</div>
      <div style="font-size:10px;color:var(--fg2);margin-top:3px">Opening: ${fmt(d.opening)} · Due: ${d.end}</div>
      <div class="pbar"><div class="pfill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div>
      <div class="plabels"><span>${pct.toFixed(0)}% cleared</span><span>${fmt(d.opening - d.currentBal)} paid</span></div>
    </div>`;
  }).join('');
};

// ── SAVINGS TAB ────────────────────────────────────────────
const renderSavings = (rows) => {
  const el = document.getElementById('savings-list');
  if (!el) return;
  if (isAccountMode) {
    if (!accountData.savings_goals.length) {
      el.innerHTML = '<div class="account-empty-state"><h2>No private savings goals</h2><p>Add a savings goal below to track your progress. Sample goals are never copied into your account.</p></div>';
      return;
    }
    el.innerHTML = accountData.savings_goals.map((goal) => {
      const currentPct = Math.min(100, goal.saved_amount / goal.target_amount * 100);
      const projected = goal.saved_amount + makeSavingsSchedule(goal).slice(0, NM).reduce((sum, amount) => sum + amount, 0);
      const projectedPct = Math.min(100, projected / goal.target_amount * 100);
      return `
        <article class="private-record">
          <h3>${escapeHtml(goal.name)}</h3>
          <p class="private-record-meta">Target: ${fmt(goal.target_amount)} · Current savings: ${fmt(goal.saved_amount)} · Projected in ${forecastYears} years: ${fmt(projected)} · ${fmt(goal.monthly_contribution)} monthly contribution · day ${goal.contribution_day}</p>
          <div class="pbar"><div class="pfill" style="width:${currentPct.toFixed(1)}%"></div></div>
          <div class="plabels"><span>${currentPct.toFixed(0)}% saved</span><span>${projectedPct >= 100 ? 'Target projected within forecast' : `${fmt(Math.max(0, goal.target_amount - projected))} remaining in forecast`}</span></div>
          <form class="private-record-form" data-savings-form="${escapeHtml(goal.id)}">
            <label class="field">Goal name<input class="text-input" name="name" type="text" maxlength="80" value="${escapeHtml(goal.name)}" required></label>
            <label class="field">Target amount (₦)<input class="text-input" name="target_amount" type="number" min="1" max="1000000000000" step="1" value="${goal.target_amount}" required></label>
            <label class="field">Already saved (₦)<input class="text-input" name="saved_amount" type="number" min="0" max="1000000000000" step="1" value="${goal.saved_amount}" required></label>
            <label class="field">Monthly contribution (₦)<input class="text-input" name="monthly_contribution" type="number" min="0" max="1000000000000" step="1" value="${goal.monthly_contribution}" required></label>
            <label class="field">Contribution day (1–31)<input class="text-input" name="contribution_day" type="number" min="1" max="31" step="1" value="${goal.contribution_day}" required></label>
            <div class="private-record-actions">
              <button class="btn-secondary" type="submit">Save changes</button>
              <button class="actual-delete danger" type="button" data-savings-delete="${escapeHtml(goal.id)}">Delete</button>
            </div>
          </form>
        </article>
      `;
    }).join('');
    return;
  }

  const accumulated = (key) => {
    if (key === '__rent__') {
      return VARIABLE.savings_goal_1.reduce((s, v) => s + v, 0)
           + VARIABLE.savings_goal_2.reduce((s, v) => s + v, 0);
    }
    return (VARIABLE[key] || []).reduce((s, v) => s + v, 0);
  };

  el.innerHTML = SAVINGS_GOALS.map(g => {
    const bal  = accumulated(g.key);
    const pct  = Math.min(100, (bal / g.target) * 100);
    const col  = g.color === 'gold' ? 'var(--gold)' : 'var(--teal)';
    const surplus = bal - g.target;
    return `<div class="scard ${g.color === 'gold' ? 'gold' : ''}">
      <div class="sname">${g.name}</div>
      <div class="smeta">Target: ${fmt(g.target)} · Deadline: ${g.deadline}</div>
      <div class="sbal" style="color:${col}">${fmt(bal)}</div>
      <div class="starget">${g.purpose}${surplus >= 0 ? ` · Surplus: ${fmt(surplus)}` : ''}</div>
      <div class="pbar" style="margin-top:12px"><div class="pfill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div>
      <div class="plabels">
        <span>${pct.toFixed(0)}% of target</span>
        <span>${pct >= 100 ? '✅ Reached' : fmt(g.target - bal) + ' to go'}</span>
      </div>
    </div>`;
  }).join('');
};

const createPrivateEntryId = () => window.crypto?.randomUUID
  ? window.crypto.randomUUID().replace(/-/g, '')
  : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
const refreshPrivateEntitySchedules = () => {
  syncAccountEntitySchedules();
  initInputs();
  renderCashflowFilters();
  recompute();
};
const savePrivateDebt = (event) => {
  event.preventDefault();
  if (!isAccountMode) return;
  const form = event.target;
  const values = new FormData(form);
  const entry = {
    id: form.dataset.debtForm || createPrivateEntryId(),
    name: String(values.get('name') || '').trim(),
    balance: Number(values.get('balance')),
    annual_interest_rate: Number(values.get('annual_interest_rate')),
    monthly_payment: Number(values.get('monthly_payment')),
    due_day: Number(values.get('due_day')),
  };
  if (!entry.name || entry.name.length > 80 || !Number.isSafeInteger(entry.balance) || entry.balance < 0
      || !Number.isFinite(entry.annual_interest_rate) || entry.annual_interest_rate < 0 || entry.annual_interest_rate > 100
      || !Number.isSafeInteger(entry.monthly_payment) || entry.monthly_payment < 0
      || !Number.isInteger(entry.due_day) || entry.due_day < 1 || entry.due_day > 31) {
    showToast('Enter a valid debt name, balance, interest rate, payment, and due day.', true);
    return;
  }
  const index = accountData.debts.findIndex(debt => debt.id === entry.id);
  if (index >= 0) accountData.debts[index] = entry;
  else accountData.debts.push(entry);
  if (form.id === 'private-debt-form') form.reset();
  refreshPrivateEntitySchedules();
  showToast(index >= 0 ? 'Private debt updated.' : 'Private debt added.');
};
const savePrivateSavingsGoal = (event) => {
  event.preventDefault();
  if (!isAccountMode) return;
  const form = event.target;
  const values = new FormData(form);
  const entry = {
    id: form.dataset.savingsForm || createPrivateEntryId(),
    name: String(values.get('name') || '').trim(),
    target_amount: Number(values.get('target_amount')),
    saved_amount: Number(values.get('saved_amount')),
    monthly_contribution: Number(values.get('monthly_contribution')),
    contribution_day: Number(values.get('contribution_day')),
  };
  if (!entry.name || entry.name.length > 80 || !Number.isSafeInteger(entry.target_amount) || entry.target_amount <= 0
      || !Number.isSafeInteger(entry.saved_amount) || entry.saved_amount < 0
      || !Number.isSafeInteger(entry.monthly_contribution) || entry.monthly_contribution < 0
      || !Number.isInteger(entry.contribution_day) || entry.contribution_day < 1 || entry.contribution_day > 31) {
    showToast('Enter a valid goal name, target, saved amount, contribution, and contribution day.', true);
    return;
  }
  const index = accountData.savings_goals.findIndex(goal => goal.id === entry.id);
  if (index >= 0) accountData.savings_goals[index] = entry;
  else accountData.savings_goals.push(entry);
  if (form.id === 'private-savings-form') form.reset();
  refreshPrivateEntitySchedules();
  showToast(index >= 0 ? 'Savings goal updated.' : 'Savings goal added.');
};
const deletePrivateEntry = (list, id) => {
  if (!isAccountMode || !window.confirm('Delete this private entry?')) return;
  if (list === 'debts') accountData.debts = accountData.debts.filter(entry => entry.id !== id);
  else accountData.savings_goals = accountData.savings_goals.filter(entry => entry.id !== id);
  refreshPrivateEntitySchedules();
  showToast(list === 'debts' ? 'Private debt deleted.' : 'Savings goal deleted.');
};

const renderFixedInputs = (container) => {
  container.innerHTML = Object.entries(FIXED_DEF).map(([key, [label, amount]]) => `
    <div class="fixed-expense-field">
      <label class="field-label" for="inp-f-${key}">${label}</label>
      <input type="number" id="inp-f-${key}" value="${amount}" oninput="recompute()">
      <label class="field-label" for="inp-fixed-day-${key}">Due day (1–31)</label>
      <input type="number" min="1" max="31" step="1" id="inp-fixed-day-${key}" value="${fixedDueDays[key] || 1}" oninput="recompute()">
    </div>
  `).join('');
};

const renderVariableInputs = (container) => {
  if (isAccountMode && !Object.keys(VARIABLE).length) {
    container.innerHTML = '<p class="inp-note">No variable expense categories yet. Add one in Category manager to enter irregular expenses, debt payments, or savings contributions.</p>';
    return;
  }
  const labels = getVariableCategoryLabels();
  container.innerHTML = Object.entries(VARIABLE).map(([key, values]) => {
    const managed = isAccountMode && isManagedExpenseKey(key);
    const managedNote = key.startsWith(MANAGED_DEBT_PREFIX) ? ' · Managed in Debts' : ' · Managed in Savings';
    return `
    <div class="var-editor">
      <div class="var-editor__header">${escapeHtml(labels[key] || key.replace(/_/g, ' '))}${managed ? managedNote : ''}</div>
      <div class="field var-editor__due-day">
        <label for="inp-variable-day-${key}">Usual payment day (1–31)</label>
        <input type="number" min="1" max="31" step="1" id="inp-variable-day-${key}" value="${variableDueDays[key] || 1}" data-var-day="${key}" ${managed ? 'disabled' : ''}>
      </div>
      <div class="var-editor__months">
        ${MONTHS.map((month, index) => `
          <label class="month-field">
            <span>${month}</span>
            <input
              type="number"
              min="0"
              step="1000"
              value="${Number(values?.[index] ?? 0)}"
              data-var-key="${key}"
              data-var-index="${index}"
              ${managed ? 'disabled' : ''}
            >
          </label>
        `).join('')}
      </div>
    </div>
  `;
  }).join('');

  container.querySelectorAll('input[data-var-key]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const el = event.currentTarget;
      const key = el.dataset.varKey;
      const index = Number(el.dataset.varIndex);
      const value = Number.parseFloat(el.value) || 0;
      if (key && Number.isInteger(index) && Array.isArray(VARIABLE[key])) {
        VARIABLE[key][index] = Math.max(0, value);
        recompute();
      }
    });
  });
  container.querySelectorAll('input[data-var-day]').forEach((input) => {
    input.addEventListener('input', recompute);
  });
};

// ── FIXED INPUTS INIT ──────────────────────────────────────
const restoreDefaultInputs = () => {
  if (isAccountMode) {
    if ((accountData.debts.length || accountData.savings_goals.length)
        && !window.confirm('Reset your plan and delete all private debts and savings goals? Actual transactions will be kept.')) return;
    accountData.debts = [];
    accountData.savings_goals = [];
    initializeBlankAccountInputs();
    syncAccountEntitySchedules();
    accountData.plan = getCurrentPlanData();
    accountData.scenarios = { ...accountData.scenarios, Current: accountData.plan };
    recompute({ persist: false });
    saveCurrentPlan();
    showToast('Private plan cleared. Enter your own figures.');
    return;
  }
  showToast('Sign in before resetting a private plan.', true);
};

const initInputs = () => {
  const salEl = document.getElementById('inp-salary');
  const colaEl = document.getElementById('inp-cola');
  const balanceEl = document.getElementById('inp-opening-balance');
  const paydayEl = document.getElementById('inp-payday');
  if (salEl) salEl.value = INCOME.salary;
  if (colaEl) colaEl.value = INCOME.cola;
  if (balanceEl) balanceEl.value = openingBalance;
  if (paydayEl) paydayEl.value = payday;

  const fg = document.getElementById('fixed-inputs');
  if (fg) renderFixedInputs(fg);

  const vg = document.getElementById('var-inputs');
  if (vg) renderVariableInputs(vg);
};

// ── TABS ───────────────────────────────────────────────────
export const showTab = (name, btn) => {
  document.querySelectorAll('.panel').forEach(panel => {
    const isActive = panel.id === 'tab-' + name;
    panel.classList.toggle('on', isActive);
    panel.hidden = !isActive;
  });
  document.querySelectorAll('.tab').forEach(t => {
    const isActive = t.dataset.tab === name;
    t.classList.toggle('on', isActive);
    t.setAttribute('aria-selected', String(isActive));
    t.tabIndex = isActive ? 0 : -1;
  });
  if (btn && btn instanceof HTMLElement) btn.classList.add('on');
  recompute({ notify: false, persist: false }); // re-render charts with fresh colours on tab switch
  if (name === 'actuals') renderActuals();
};

// ── THEME TOGGLE ───────────────────────────────────────────
export const toggleTheme = () => {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
  recompute({ notify: false, persist: false });
  showToast(`Switched to ${current === 'dark' ? 'light' : 'dark'} mode.`);
};

const updateAccountControls = user => {
  const signedIn = Boolean(user);
  const status = document.getElementById('account-status');
  const openButton = document.getElementById('account-open');
  const signOutButton = document.getElementById('account-sign-out');
  const noticeTitle = document.getElementById('privacy-notice-title');
  const notice = document.querySelector('.privacy-notice');
  const debtFormCard = document.getElementById('private-debt-form-card');
  const savingsFormCard = document.getElementById('private-savings-form-card');
  document.body.classList.toggle('auth-required', !signedIn);
  document.title = signedIn ? 'Wealth Engine — Private Plan' : 'Wealth Engine — Sign in';
  document.getElementById('forecast-subtitle').textContent =
    signedIn
      ? `Private account plan · ${forecastYears}-year forecast · ${MONTHS[0]} – ${MONTHS.at(-1)}`
      : 'Sign in to create your private plan';
  document.getElementById('debt-chart-title').textContent = 'Private debt tracking';
  document.getElementById('savings-chart-title').textContent = 'Private savings tracking';
  document.getElementById('chart-debts')?.setAttribute(
    'aria-label',
    'Line chart of projected private debt balances by month',
  );
  document.getElementById('chart-savings')?.setAttribute(
    'aria-label',
    'Line chart of projected private savings goal balances by month',
  );
  if (status) status.textContent = signedIn ? user.email || 'Private account' : 'Sign in required';
  if (openButton) openButton.hidden = signedIn;
  const gateButton = document.getElementById('login-gate-open');
  if (gateButton) gateButton.disabled = accountAvailability !== 'ready';
  if (openButton && !signedIn) {
    openButton.disabled = accountAvailability !== 'ready';
    openButton.title = accountAvailability === 'unavailable'
      ? 'Start the API with npx vercel dev to enable sign-in.'
      : accountAvailability === 'unconfigured'
        ? 'Configure SUPABASE_URL and SUPABASE_ANON_KEY to enable accounts.'
        : '';
  }
  if (signOutButton) signOutButton.hidden = !signedIn;
  if (debtFormCard) debtFormCard.hidden = !signedIn;
  if (savingsFormCard) savingsFormCard.hidden = !signedIn;
  if (noticeTitle) noticeTitle.textContent = 'Private account:';
  if (notice) {
    notice.lastChild.textContent = ' Your plan, actuals, debts, and savings goals are saved to your account.';
  }
  document.querySelectorAll('#tab-inputs input, #tab-inputs select').forEach((control) => {
    control.disabled = !signedIn;
  });
  document.querySelectorAll('#tab-inputs button').forEach((button) => {
    button.disabled = !signedIn;
  });
  document.querySelectorAll('.quickbar button').forEach((button) => {
    button.disabled = !signedIn;
  });
  document.querySelectorAll('#actual-entry-form input, #actual-entry-form select, #actual-entry-form button').forEach((control) => {
    control.disabled = !signedIn;
  });
  document.querySelectorAll('#private-debt-form-card input, #private-debt-form-card button, #private-savings-form-card input, #private-savings-form-card button').forEach((control) => {
    control.disabled = !signedIn;
  });
};

let accountAvailability = 'checking';
const checkAccountAvailability = async () => {
  try {
    const health = await requestApi('/health', { authenticate: false });
    accountAvailability = health?.accounts_configured ? 'ready' : 'unconfigured';
    if (accountAvailability === 'unconfigured') {
      showToast('API is running, but Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY before signing in.', true);
    }
  } catch (error) {
    accountAvailability = 'unavailable';
    showToast('Sign-in is unavailable: start the app with `npx vercel dev`. A static Live Server cannot run the account API.', true);
  }
  if (!isAccountMode) updateAccountControls(null);
};

const resetPlanState = () => {
  Object.keys(VARIABLE).forEach(key => delete VARIABLE[key]);
  Object.keys(FIXED_DEF).forEach(key => delete FIXED_DEF[key]);
  Object.entries(DEFAULT_FIXED).forEach(([key, [label]]) => { FIXED_DEF[key] = [label, 0]; });
  Object.keys(INCOME).forEach(key => { INCOME[key] = 0; });
  openingBalance = 0;
  payday = 1;
  fixedDueDays = Object.fromEntries(Object.keys(DEFAULT_FIXED).map(key => [key, 1]));
  variableDueDays = {};
  setForecastDuration(FORECAST_YEARS);
};

const normalizePrivateEntries = (data) => {
  const debts = Array.isArray(data?.debts) ? data.debts.flatMap((entry) => {
    const balance = Number(entry?.balance);
    const annualInterestRate = Number(entry?.annual_interest_rate);
    const monthlyPayment = Number(entry?.monthly_payment);
    const dueDay = Number(entry?.due_day);
    if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_]{1,32}$/.test(entry.id)
        || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80
        || !Number.isSafeInteger(balance) || balance < 0
        || !Number.isFinite(annualInterestRate) || annualInterestRate < 0 || annualInterestRate > 100
        || !Number.isSafeInteger(monthlyPayment) || monthlyPayment < 0
        || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return [];
    return [{ id: entry.id, name: entry.name.trim(), balance, annual_interest_rate: annualInterestRate, monthly_payment: monthlyPayment, due_day: dueDay }];
  }) : [];
  const savingsGoals = Array.isArray(data?.savings_goals) ? data.savings_goals.flatMap((entry) => {
    const targetAmount = Number(entry?.target_amount);
    const savedAmount = Number(entry?.saved_amount);
    const monthlyContribution = Number(entry?.monthly_contribution);
    const contributionDay = Number(entry?.contribution_day);
    if (!entry || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_]{1,32}$/.test(entry.id)
        || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80
        || !Number.isSafeInteger(targetAmount) || targetAmount <= 0
        || !Number.isSafeInteger(savedAmount) || savedAmount < 0
        || !Number.isSafeInteger(monthlyContribution) || monthlyContribution < 0
        || !Number.isInteger(contributionDay) || contributionDay < 1 || contributionDay > 31) return [];
    return [{ id: entry.id, name: entry.name.trim(), target_amount: targetAmount, saved_amount: savedAmount, monthly_contribution: monthlyContribution, contribution_day: contributionDay }];
  }) : [];
  if ((Array.isArray(data?.debts) && debts.length !== data.debts.length)
      || (Array.isArray(data?.savings_goals) && savingsGoals.length !== data.savings_goals.length)) {
    showToast('Some saved debt or savings entries were invalid and were not loaded.', true);
  }
  return { debts, savings_goals: savingsGoals };
};

const initializeBlankAccountInputs = () => {
  Object.keys(VARIABLE).forEach(key => delete VARIABLE[key]);
  Object.keys(FIXED_DEF).forEach(key => delete FIXED_DEF[key]);
  Object.entries(DEFAULT_FIXED).forEach(([key, [label]]) => {
    FIXED_DEF[key] = [label, 0];
  });
  Object.keys(INCOME).forEach(key => {
    INCOME[key] = 0;
  });
  openingBalance = 0;
  payday = 1;
  fixedDueDays = Object.fromEntries(Object.keys(DEFAULT_FIXED).map(key => [key, 1]));
  variableDueDays = {};
  initInputs();
  renderCashflowFilters();
};

const activateAccount = (user, data) => {
  isAccountMode = false;
  clearTimeout(accountSaveTimer);
  resetPlanState();
  accountData = {
    plan: data?.plan && typeof data.plan === 'object' ? data.plan : null,
    scenarios: data?.scenarios && typeof data.scenarios === 'object' && !Array.isArray(data.scenarios)
      ? data.scenarios
      : {},
    actuals: Array.isArray(data?.actuals) ? data.actuals : [],
    ...normalizePrivateEntries(data),
  };
  initializeBlankAccountInputs();
  if (!accountData.plan || !loadSavedPlan(accountData.plan)) {
    accountData.plan = getCurrentPlanData();
  }
  syncAccountEntitySchedules();
  isAccountMode = true;
  if (!Object.keys(accountData.scenarios).length) {
    accountData.scenarios = { Current: accountData.plan };
  }
  accountUser = user;
  initInputs();
  accountData.plan = getCurrentPlanData();
  populateScenarioControls();
  populateActualCategorySelect();
  renderCashflowFilters();
  renderActuals();
  updateAccountControls(user);
  recompute({ persist: false });
};

const lockAccountView = () => {
  isAccountMode = false;
  accountUser = null;
  accountData = { plan: null, scenarios: {}, actuals: [], debts: [], savings_goals: [] };
  clearTimeout(accountSaveTimer);
  clearSession();
  resetPlanState();
  initializeBlankAccountInputs();
  Object.keys(CHARTS).forEach(destroyChart);
  ['plan-summary', 'cash-risk', 'kpi-grid', 'alert-row', 'insights-grid', 'cf-table',
    'debt-list', 'savings-list', 'actuals-summary', 'actuals-comparison', 'actuals-entries']
    .forEach(id => { const element = document.getElementById(id); if (element) element.replaceChildren(); });
  updateAccountControls(null);
};

const restoreAccountFromSession = async () => {
  let raw;
  try {
    raw = getSession();
  } catch (error) {
    showToast(error.message, true);
    return false;
  }
  if (!raw) return false;
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch (error) {
    clearSession();
    showToast('The saved sign-in session is invalid. Please sign in again.', true);
    return false;
  }
  if (!stored?.access_token || !stored?.refresh_token || !Number.isFinite(Number(stored.expires_at))) {
    clearSession();
    showToast('The saved sign-in session is incomplete. Please sign in again.', true);
    return false;
  }
  accountSession = stored;
  try {
    await refreshSessionIfNeeded();
    const [user, result] = await Promise.all([
      requestApi('/auth/me'),
      requestApi('/account/data'),
    ]);
    activateAccount(user, result?.data || {});
    return true;
  } catch (error) {
    clearSession();
    lockAccountView();
    showToast(error.message || 'Your sign-in session could not be restored.', true);
    return false;
  }
};

const finishSignIn = async session => {
  if (!session?.access_token || !session?.refresh_token) {
    throw new Error('The account service did not return a usable sign-in session.');
  }
  setSession(session);
  try {
    const [user, result] = await Promise.all([
      requestApi('/auth/me'),
      requestApi('/account/data'),
    ]);
    activateAccount(user, result?.data || {});
  } catch (error) {
    clearSession();
    lockAccountView();
    throw error;
  }
  document.getElementById('account-dialog')?.close();
  document.getElementById('account-password').value = '';
  showToast('Signed in. Your private account data is ready.');
};

const setAccountFormStatus = (message, isError = false) => {
  const status = document.getElementById('account-form-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', isError);
};

const signIn = async event => {
  event.preventDefault();
  const email = document.getElementById('account-email').value.trim();
  const password = document.getElementById('account-password').value;
  const button = document.getElementById('account-login');
  button.disabled = true;
  setAccountFormStatus('Signing in…');
  try {
    const session = await requestApi('/auth/login', {
      method: 'POST',
      body: { email, password },
      authenticate: false,
    });
    await finishSignIn(session);
  } catch (error) {
    setAccountFormStatus(error.message || 'Sign-in failed.', true);
  } finally {
    button.disabled = false;
  }
};

const signUp = async () => {
  const email = document.getElementById('account-email').value.trim();
  const password = document.getElementById('account-password').value;
  const button = document.getElementById('account-sign-up');
  if (!document.getElementById('account-form').reportValidity()) return;
  button.disabled = true;
  setAccountFormStatus('Creating your account…');
  try {
    const result = await requestApi('/auth/signup', {
      method: 'POST',
      body: { email, password },
      authenticate: false,
    });
    const session = result?.session || result;
    if (session?.access_token && session?.refresh_token) {
      await finishSignIn(session);
    } else {
      setAccountFormStatus('Account created. Check your email to confirm it, then sign in.');
    }
  } catch (error) {
    setAccountFormStatus(error.message || 'Could not create your account.', true);
  } finally {
    button.disabled = false;
  }
};

const signOut = async () => {
  clearTimeout(accountSaveTimer);
  try {
    await persistAccountData();
  } catch (error) {
    showToast(error.message || 'Could not save your latest changes before sign-out.', true);
    return;
  }
  try {
    await requestApi('/auth/logout', { method: 'POST' });
  } catch (error) {
    showToast(error.message || 'Could not end the server session.', true);
  } finally {
    lockAccountView();
  }
};

// ── BOOT ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(getStoredTheme());
  setForecastDuration(forecastYears);
  resetPlanState();
  initializeBlankAccountInputs();
  updateAccountControls(null);
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => showTab(button.dataset.tab, button));
    button.addEventListener('keydown', (event) => {
      const tabs = [...document.querySelectorAll('.tab')];
      const index = tabs.indexOf(button);
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      showTab(nextTab.dataset.tab, nextTab);
      nextTab.focus();
    });
  });
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  document.getElementById('account-open')?.addEventListener('click', () => {
    setAccountFormStatus('');
    document.getElementById('account-dialog')?.showModal();
  });
  document.getElementById('login-gate-open')?.addEventListener('click', () => {
    setAccountFormStatus('');
    document.getElementById('account-dialog')?.showModal();
  });
  document.getElementById('account-close')?.addEventListener('click', () => {
    document.getElementById('account-dialog')?.close();
  });
  document.getElementById('account-form')?.addEventListener('submit', signIn);
  document.getElementById('account-sign-up')?.addEventListener('click', signUp);
  document.getElementById('account-sign-out')?.addEventListener('click', signOut);
  document.getElementById('forecast-years')?.addEventListener('change', event => {
    if (!setForecastDuration(Number(event.currentTarget.value))) {
      showToast('Choose a forecast duration from 1 to 10 years.', true);
      return;
    }
    initInputs();
    updateAccountControls(accountUser);
    recompute();
    showToast(`Forecast updated to ${forecastYears} years.`);
  });
  document.getElementById('cashflow-month')?.addEventListener('change', () => {
    if (isAccountMode) renderCFTable(compute());
  });
  window.matchMedia('(max-width: 640px)').addEventListener('change', () => {
    if (isAccountMode) renderCFTable(compute());
  });
  document.getElementById('reset-plan')?.addEventListener('click', () => {
    restoreDefaultInputs();
  });
  document.getElementById('save-plan')?.addEventListener('click', () => saveCurrentPlan(true));
  document.getElementById('export-plan')?.addEventListener('click', exportPlan);
  document.getElementById('export-csv')?.addEventListener('click', exportCsv);
  document.getElementById('print-summary')?.addEventListener('click', printSummary);
  document.getElementById('quick-reset-plan')?.addEventListener('click', () => {
    restoreDefaultInputs();
  });
  document.getElementById('quick-save-plan')?.addEventListener('click', () => saveCurrentPlan(true));
  document.getElementById('quick-export-plan')?.addEventListener('click', exportPlan);
  document.getElementById('quick-export-csv')?.addEventListener('click', exportCsv);
  document.getElementById('quick-print-summary')?.addEventListener('click', printSummary);
  const actualsMonth = document.getElementById('actuals-month');
  if (actualsMonth) {
    actualsMonth.value = getCurrentMonthKey();
    actualsMonth.max = getCurrentMonthKey();
    actualsMonth.addEventListener('change', renderActuals);
  }
  const actualDate = document.getElementById('actual-date');
  if (actualDate) {
    const today = getTodayDateKey();
    actualDate.value = today;
    actualDate.max = today;
  }
  document.getElementById('actual-type')?.addEventListener('change', populateActualCategorySelect);
  document.getElementById('actual-entry-form')?.addEventListener('submit', addActualEntry);
  document.getElementById('private-debt-form')?.addEventListener('submit', savePrivateDebt);
  document.getElementById('private-savings-form')?.addEventListener('submit', savePrivateSavingsGoal);
  document.getElementById('debt-list')?.addEventListener('submit', savePrivateDebt);
  document.getElementById('debt-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-debt-delete]');
    if (button) deletePrivateEntry('debts', button.dataset.debtDelete);
  });
  document.getElementById('savings-list')?.addEventListener('submit', savePrivateSavingsGoal);
  document.getElementById('savings-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-savings-delete]');
    if (button) deletePrivateEntry('savings_goals', button.dataset.savingsDelete);
  });
  document.getElementById('save-scenario')?.addEventListener('click', saveCurrentScenario);
  document.getElementById('apply-scenario')?.addEventListener('click', () => {
    const select = document.getElementById('scenario-select');
    if (select && !applyScenario(select.value)) showToast('That scenario could not be found.', true);
  });
  document.getElementById('delete-scenario')?.addEventListener('click', () => {
    const select = document.getElementById('scenario-select');
    if (!select || !select.value) return;
    const scenarios = getScenarioStore();
    const name = select.value;
    if (Object.keys(scenarios).length <= 1) {
      alert('Keep at least one scenario available.');
      return;
    }
    delete scenarios[name];
    if (!saveScenarioStore(scenarios)) {
      showToast('Could not delete the scenario from your account.', true);
      return;
    }
    populateScenarioControls();
    showToast(`Scenario “${name}” deleted.`);
  });
  document.getElementById('add-category')?.addEventListener('click', addCategory);
  document.getElementById('remove-category')?.addEventListener('click', removeCategory);
  await checkAccountAvailability();
  const restored = await restoreAccountFromSession();
  if (!restored) lockAccountView();
});

// Expose to inline HTML event handlers
window.recompute  = recompute;
window.showTab    = showTab;
window.toggleTheme = toggleTheme;
window.restoreDefaultInputs = restoreDefaultInputs;
window.saveCurrentPlan = saveCurrentPlan;
window.exportPlan = exportPlan;
window.exportCsv = exportCsv;
window.printSummary = printSummary;
window.saveCurrentScenario = saveCurrentScenario;
window.applyScenario = applyScenario;
window.addCategory = addCategory;
window.removeCategory = removeCategory;
