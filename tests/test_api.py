import asyncio
import os
import unittest
from unittest.mock import patch

import httpx

from api import index


TEST_USER_ID = "a18b67d3-68ee-4ee7-9120-90ce04a985db"
TEST_TOKEN = "signed-in-user-token"


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_ANON_KEY": "public-anon-key",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def request(self, method, path, **kwargs):
        async def send():
            transport = httpx.ASGITransport(app=index.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                return await client.request(method, path, **kwargs)

        return asyncio.run(send())

    def test_demo_routes_are_read_only_and_do_not_call_supabase(self):
        with patch.object(index, "_supabase_request") as upstream:
            plan = self.request("GET", "/demo/plan")
            scenarios = self.request("GET", "/demo/scenarios")
            actuals = self.request("GET", "/demo/actuals")
            write = self.request("PUT", "/demo/plan", json={})

        self.assertEqual(plan.status_code, 200)
        self.assertEqual(plan.json()["income"]["salary"], 650000)
        self.assertIn("Rent focus", scenarios.json())
        self.assertEqual(actuals.json(), [])
        self.assertEqual(write.status_code, 405)
        upstream.assert_not_called()

    def test_vercel_api_route_reaches_demo_route(self):
        response = self.request("GET", "/api/demo/plan")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["income"]["salary"], 650000)

    def test_fastapi_serves_the_frontend_and_assets(self):
        page = self.request("GET", "/")
        script = self.request("GET", "/js/app.js")
        stylesheet = self.request("GET", "/css/style.css")
        icon = self.request("GET", "/favicon.svg")
        legacy_icon = self.request("GET", "/favicon.ico")

        self.assertEqual(page.status_code, 200)
        self.assertIn('id="account-open"', page.text)
        self.assertEqual(script.status_code, 200)
        self.assertIn("activateDemo", script.text)
        self.assertEqual(stylesheet.status_code, 200)
        self.assertEqual(icon.status_code, 200)
        self.assertEqual(legacy_icon.status_code, 307)
        self.assertEqual(legacy_icon.headers["location"], "/favicon.svg")

    def test_health_reports_account_configuration_without_exposing_credentials(self):
        response = self.request("GET", "/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "accounts_configured": True})

        with patch.dict(os.environ, {}, clear=True):
            unconfigured = self.request("GET", "/health")
        self.assertEqual(unconfigured.status_code, 200)
        self.assertEqual(unconfigured.json()["accounts_configured"], False)

    def test_account_data_requires_a_verified_session(self):
        with patch.object(index, "_supabase_request") as upstream:
            response = self.request("GET", "/account/data")

        self.assertEqual(response.status_code, 401)
        upstream.assert_not_called()

    def test_auth_refresh_forwards_only_the_supplied_refresh_token(self):
        with patch.object(index, "_supabase_request", return_value={"access_token": "new"}) as upstream:
            response = self.request(
                "POST",
                "/auth/refresh",
                json={"refresh_token": "refresh-token"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["access_token"], "new")
        self.assertEqual(upstream.call_args.kwargs["payload"], {"refresh_token": "refresh-token"})

    def test_account_read_is_scoped_to_verified_user(self):
        def supabase_request(path, **kwargs):
            if path == "/auth/v1/user":
                return {"id": TEST_USER_ID}
            self.assertIn(f"user_id=eq.{TEST_USER_ID}", path)
            self.assertEqual(kwargs["token"], TEST_TOKEN)
            return [{"data": {"plan": None, "scenarios": {}, "actuals": []}}]

        with patch.object(index, "_supabase_request", side_effect=supabase_request):
            response = self.request(
                "GET",
                "/account/data",
                headers={"Authorization": f"Bearer {TEST_TOKEN}"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["actuals"], [])

    def test_account_write_uses_verified_user_id_not_request_data(self):
        calls = []

        def supabase_request(path, **kwargs):
            calls.append((path, kwargs))
            if path == "/auth/v1/user":
                return {"id": TEST_USER_ID}
            return [{"data": kwargs["payload"][0]["data"]}]

        body = {
            "data": {
                "plan": None,
                "scenarios": {},
                "actuals": [],
                "debts": [{
                    "id": "debt_1",
                    "name": "Car loan",
                    "balance": 500000,
                    "annual_interest_rate": 12.5,
                    "monthly_payment": 50000,
                    "due_day": 10,
                }],
                "savings_goals": [{
                    "id": "goal_1",
                    "name": "Emergency fund",
                    "target_amount": 1000000,
                    "saved_amount": 200000,
                    "monthly_contribution": 25000,
                    "contribution_day": 5,
                }],
            }
        }
        with patch.object(index, "_supabase_request", side_effect=supabase_request):
            response = self.request(
                "PUT",
                "/account/data",
                json=body,
                headers={"Authorization": f"Bearer {TEST_TOKEN}"},
            )

        self.assertEqual(response.status_code, 200)
        write = calls[-1][1]
        self.assertEqual(write["payload"][0]["user_id"], TEST_USER_ID)
        self.assertEqual(write["token"], TEST_TOKEN)
        self.assertIn("resolution=merge-duplicates", write["prefer"])
        self.assertEqual(response.json()["data"]["debts"], body["data"]["debts"])
        self.assertEqual(response.json()["data"]["savings_goals"], body["data"]["savings_goals"])

    def test_account_write_rejects_invalid_private_entry(self):
        body = {
            "data": {
                "plan": None,
                "scenarios": {},
                "actuals": [],
                "debts": [{
                    "id": "debt_1",
                    "name": "Car loan",
                    "balance": 500000,
                    "annual_interest_rate": 12.5,
                    "monthly_payment": 50000,
                    "due_day": 32,
                }],
                "savings_goals": [],
            }
        }
        response = self.request("PUT", "/account/data", json=body)
        self.assertEqual(response.status_code, 422)

    def test_account_write_rejects_duplicate_private_entry_ids(self):
        debt = {
            "id": "debt_1",
            "name": "Car loan",
            "balance": 500000,
            "annual_interest_rate": 12.5,
            "monthly_payment": 50000,
            "due_day": 10,
        }
        body = {"data": {"debts": [debt, debt]}}
        response = self.request("PUT", "/account/data", json=body)
        self.assertEqual(response.status_code, 422)

    def test_account_write_rejects_client_supplied_owner(self):
        body = {
            "user_id": "00000000-0000-0000-0000-000000000000",
            "data": {"plan": None, "scenarios": {}, "actuals": []},
        }
        response = self.request(
            "PUT",
            "/account/data",
            json=body,
            headers={"Authorization": f"Bearer {TEST_TOKEN}"},
        )
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
