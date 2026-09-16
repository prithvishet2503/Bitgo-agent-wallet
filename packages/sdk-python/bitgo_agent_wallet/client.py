"""
BitGo Agent Wallet Python SDK.

Section 6.7 - Developer Tooling: "SDK: language bindings matching BitGo's existing
SDK support (at minimum TypeScript/Python)". This mirrors the TypeScript client
(packages/sdk) method-for-method against the same REST API (apps/backend) - see
that file's docstrings for the PRD section each method implements.
"""
from __future__ import annotations

from typing import Any, Optional

import requests


class BitGoAgentWalletApiError(Exception):
    def __init__(self, message: str, code: str, http_status: int, issues: Optional[Any] = None):
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.issues = issues


class BitGoAgentWalletClient:
    def __init__(
        self,
        base_url: str = "http://localhost:4000/api/v1",
        api_token: Optional[str] = None,
        enterprise_id: Optional[str] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_token = api_token
        self.enterprise_id = enterprise_id
        self.session = requests.Session()

    def _request(self, method: str, path: str, json: Optional[dict] = None) -> Any:
        headers = {}
        if self.api_token:
            headers["authorization"] = f"Bearer {self.api_token}"
        if self.enterprise_id:
            headers["x-enterprise-id"] = self.enterprise_id
        resp = self.session.request(method, f"{self.base_url}{path}", json=json, headers=headers)
        body = resp.json() if resp.text else None
        if not resp.ok:
            error = (body or {}).get("error", {})
            raise BitGoAgentWalletApiError(
                error.get("message", f"Request failed with status {resp.status_code}"),
                error.get("code", "UNKNOWN"),
                resp.status_code,
                error.get("issues"),
            )
        return body

    # --- authenticate ---
    def authenticate(self, api_token: str) -> dict:
        identity = self._request("POST", "/auth/authenticate", {"apiToken": api_token})
        self.api_token = identity["apiToken"]
        self.enterprise_id = identity["enterpriseId"]
        return identity

    # --- "Sign up my institution": Organization -> Enterprise -> admin User ---
    def create_organization(self, **input: Any) -> dict:
        result = self._request("POST", "/organizations", input)
        self.api_token = result["apiToken"]
        self.enterprise_id = result["enterprise"]["id"]
        return result

    # --- An Organization can contain more than one Enterprise ---
    def create_enterprise(self, **input: Any) -> dict:
        return self._request("POST", "/enterprises", input)

    def list_enterprises(self) -> list[dict]:
        return self._request("GET", "/enterprises")

    # --- Section 6.1 ---
    def create_agent_sub_wallet(self, **input: Any) -> dict:
        return self._request("POST", "/sub-wallets", input)

    def list_agent_sub_wallets(self) -> list[dict]:
        return self._request("GET", "/sub-wallets")

    def get_agent_sub_wallet(self, sub_wallet_id: str) -> dict:
        return self._request("GET", f"/sub-wallets/{sub_wallet_id}")

    # --- get-balance ---
    def get_balance(self, sub_wallet_id: str) -> dict:
        return self._request("GET", f"/sub-wallets/{sub_wallet_id}/balance")

    # --- revoke (Section 6.6 kill switch) ---
    def revoke(self, sub_wallet_id: str, reason: Optional[str] = None) -> dict:
        return self._request("POST", f"/sub-wallets/{sub_wallet_id}/suspend", {"reason": reason})

    # --- Section 6.4 ---
    def set_autonomy_mode(self, sub_wallet_id: str, mode: str) -> dict:
        return self._request("POST", f"/sub-wallets/{sub_wallet_id}/autonomy-mode", {"mode": mode})

    # --- Section 6.10 ---
    def delegate_eip7702(self, sub_wallet_id: str) -> dict:
        return self._request("POST", f"/sub-wallets/{sub_wallet_id}/delegate-eip7702")

    # --- Section 6.2 ---
    def create_pact(self, **input: Any) -> dict:
        return self._request("POST", "/pacts", input)

    def update_pact(self, pact_id: str, **patch: Any) -> dict:
        return self._request("PATCH", f"/pacts/{pact_id}", patch)

    def get_pact_for_sub_wallet(self, sub_wallet_id: str) -> Optional[dict]:
        try:
            return self._request("GET", f"/pacts/by-sub-wallet/{sub_wallet_id}")
        except BitGoAgentWalletApiError as e:
            if e.http_status == 404:
                return None
            raise

    # --- send ---
    def send(self, **request: Any) -> dict:
        return self._request("POST", "/transactions", request)

    # --- get-status ---
    def get_status(self, transaction_id: str) -> dict:
        return self._request("GET", f"/transactions/{transaction_id}")

    def list_transactions(self, sub_wallet_id: Optional[str] = None) -> list[dict]:
        qs = f"?subWalletId={sub_wallet_id}" if sub_wallet_id else ""
        return self._request("GET", f"/transactions{qs}")

    # --- Section 6.5 ---
    def list_pending_approvals(self) -> list[dict]:
        return self._request("GET", "/approvals/pending")

    def decide_approval(self, approval_request_id: str, decision: str, reason: Optional[str] = None) -> dict:
        return self._request("POST", f"/approvals/{approval_request_id}/decide", {"decision": decision, "reason": reason})

    # --- Section 6.8 ---
    def query_audit_log(self, **query: Any) -> list[dict]:
        params = "&".join(f"{k}={v}" for k, v in query.items() if v is not None)
        return self._request("GET", f"/audit-log?{params}")

    # --- Section 6.9 ---
    def simulate_incoming(self, **input: Any) -> dict:
        return self._request("POST", "/incoming", input)

    def list_quarantined(self) -> list[dict]:
        return self._request("GET", "/incoming/quarantined")

    def release_quarantine(self, incoming_transaction_id: str, note: Optional[str] = None) -> dict:
        return self._request("POST", f"/incoming/{incoming_transaction_id}/release", {"note": note})

    # --- Scheduled / recurring transactions - a saved template for `send`,
    # fired later by the backend's scheduleSweeper instead of synchronously. ---
    def create_schedule(self, **input: Any) -> dict:
        return self._request("POST", "/schedules", input)

    def list_schedules(self, sub_wallet_id: Optional[str] = None) -> list[dict]:
        qs = f"?subWalletId={sub_wallet_id}" if sub_wallet_id else ""
        return self._request("GET", f"/schedules{qs}")

    def get_schedule(self, schedule_id: str) -> dict:
        return self._request("GET", f"/schedules/{schedule_id}")

    def cancel_schedule(self, schedule_id: str) -> dict:
        return self._request("POST", f"/schedules/{schedule_id}/cancel")

    def pause_schedule(self, schedule_id: str) -> dict:
        return self._request("POST", f"/schedules/{schedule_id}/pause")

    def resume_schedule(self, schedule_id: str) -> dict:
        return self._request("POST", f"/schedules/{schedule_id}/resume")
