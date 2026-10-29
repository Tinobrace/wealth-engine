DEMO_PLAN = {
    "income": {"salary": 650000, "cola": 50000},
    "fixed": {
        "housing": 80000,
        "groceries": 45000,
        "utilities": 18000,
        "health": 12000,
        "transport": 25000,
        "household": 15000,
        "personal": 8000,
        "clothing": 8000,
    },
    "variable": {
        "loan_bundle": [115000] * 12 + [40000],
        "short_term_loan": [25000, 25000, 25000],
        "savings_goal_1": [30000] * 8,
        "savings_goal_2": [25000] * 9,
        "community_pool": [0] + [20000] * 7,
        "family_support": [0] + [15000] * 5 + [20000] * 7,
        "home_project": [0, 100000, 0, 50000, 0, 0, 50000, 0, 0, 50000, 0, 0, 50000],
    },
    "openingBalance": 100000,
    "payday": 25,
    "fixedDueDays": {
        "housing": 1,
        "groceries": 5,
        "utilities": 8,
        "health": 10,
        "transport": 1,
        "household": 12,
        "personal": 15,
        "clothing": 20,
    },
    "variableDueDays": {
        "loan_bundle": 15,
        "short_term_loan": 10,
        "savings_goal_1": 27,
        "savings_goal_2": 27,
        "community_pool": 20,
        "family_support": 5,
        "home_project": 1,
    },
}

DEMO_SCENARIOS = {
    "Current": DEMO_PLAN,
    "Rent focus": {
        **DEMO_PLAN,
        "variable": {
            **DEMO_PLAN["variable"],
            "savings_goal_2": [50000] * 9,
        },
    },
    "Aggressive debt payoff": {
        **DEMO_PLAN,
        "variable": {
            **DEMO_PLAN["variable"],
            "loan_bundle": [170000] * 8 + [40000, 115000, 115000, 115000, 40000],
            "savings_goal_1": [],
            "savings_goal_2": [],
        },
    },
}
