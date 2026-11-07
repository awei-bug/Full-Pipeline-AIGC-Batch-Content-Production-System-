"""data-hub 鉴权与租户边界。

零依赖，可直接 `python -m pytest apps/data-hub/test_authz.py -q`。
"""
from unittest.mock import patch

import app as hub


class FakeHandler:
    def __init__(self, headers):
        self.headers = headers


def test_empty_token_config_denies_everything():
    with patch.object(hub, "HUB_TOKENS", ""):
        assert hub.authorized(FakeHandler({})) is False
        assert hub.authorized(FakeHandler({"X-Hub-Token": "anything"})) is False


def test_token_must_match_declared_tenant():
    with patch.object(hub, "HUB_TOKENS", "demo:secret,other:other-secret"):
        assert hub.authorized(FakeHandler({
            "X-Hub-Tenant": "demo", "X-Hub-Token": "secret",
        })) is True
        # 持 other 的令牌不能访问 demo
        assert hub.authorized(FakeHandler({
            "X-Hub-Tenant": "demo", "X-Hub-Token": "other-secret",
        })) is False
        # 缺租户头、未知租户都不放行
        assert hub.authorized(FakeHandler({"X-Hub-Token": "secret"})) is False
        assert hub.authorized(FakeHandler({
            "X-Hub-Tenant": "unknown", "X-Hub-Token": "secret",
        })) is False


def test_bearer_header_still_works_with_tenant():
    with patch.object(hub, "HUB_TOKENS", "demo:secret"):
        assert hub.authorized(FakeHandler({
            "X-Hub-Tenant": "demo", "Authorization": "Bearer secret",
        })) is True


def test_target_tenant_from_path_body_and_query():
    assert hub.target_tenant("/hub/products/demo/SKU-1/ack") == "demo"
    assert hub.target_tenant("/hub/products/other/SKU-1/status") == "other"
    assert hub.target_tenant("/hub/ingest", {"tenant_slug": "other"}) == "other"
    assert hub.target_tenant("/hub/search", {"tenant": "demo"}) == "demo"
    assert hub.target_tenant("/hub/products", {}, {"tenant": "demo"}) == "demo"
    assert hub.target_tenant("/hub/stats", {}, {}) == ""
