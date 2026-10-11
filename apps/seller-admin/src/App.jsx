import { useEffect, useMemo, useState } from "react";

import {
  apiBaseUrl,
  cancelOrder,
  createOrder,
  createProduct,
  createStore,
  deleteProduct,
  fulfillOrder,
  generateProductContent,
  listOrders,
  listProducts,
  listStores,
  login,
  register,
  updateProduct,
} from "./api.js";

const TOKEN_KEY = "commerce_seller_token";

const ORDER_FILTERS = [
  { key: "all", label: "All" },
  { key: "pending_payment", label: "Pending pay" },
  { key: "paid", label: "Paid" },
  { key: "fulfilled", label: "Fulfilled" },
  { key: "cancelled", label: "Cancelled" },
  { key: "payment_failed", label: "Pay failed" },
];

function money(cents, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format((Number(cents) || 0) / 100);
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function orderStatusMeta(status) {
  switch (status) {
    case "paid":
      return { label: "Paid", tone: "success" };
    case "fulfilled":
    case "completed":
      return { label: status === "completed" ? "Completed" : "Fulfilled", tone: "info" };
    case "pending_payment":
      return { label: "Pending payment", tone: "warning" };
    case "payment_failed":
      return { label: "Payment failed", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted" };
    default:
      return { label: status || "Unknown", tone: "muted" };
  }
}

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [userEmail, setUserEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState("login");
  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [orderFilter, setOrderFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState("catalog");

  const [storeName, setStoreName] = useState("Nordic Home");
  const [storeSlug, setStoreSlug] = useState("nordic-home");
  const [productTitle, setProductTitle] = useState("Stainless Steel Bottle");
  const [productPrice, setProductPrice] = useState("12.99");
  const [productStock, setProductStock] = useState("50");
  const [productStatus, setProductStatus] = useState("active");
  const [editingProductId, setEditingProductId] = useState("");
  const [trackingDrafts, setTrackingDrafts] = useState({});

  const selectedStore = useMemo(
    () => stores.find((item) => item.id === selectedStoreId) || stores[0] || null,
    [stores, selectedStoreId],
  );

  const orderCounts = useMemo(() => {
    const counts = { all: orders.length };
    for (const order of orders) {
      counts[order.status] = (counts[order.status] || 0) + 1;
    }
    return counts;
  }, [orders]);

  const filteredOrders = useMemo(() => {
    if (orderFilter === "all") return orders;
    return orders.filter((order) => order.status === orderFilter);
  }, [orders, orderFilter]);

  async function refreshCatalog(nextToken = token, storeId = selectedStore?.id) {
    if (!nextToken || !storeId) {
      setProducts([]);
      setOrders([]);
      return;
    }
    const [productData, orderData] = await Promise.all([
      listProducts(nextToken, storeId),
      listOrders(nextToken, storeId),
    ]);
    setProducts(productData.items || []);
    setOrders(orderData.items || []);
  }

  useEffect(() => {
    if (!token) {
      setStores([]);
      setProducts([]);
      setOrders([]);
      return;
    }

    let active = true;
    (async () => {
      try {
        const data = await listStores(token);
        if (!active) return;
        setStores(data.items || []);
        if (!selectedStoreId && data.items?.[0]?.id) {
          setSelectedStoreId(data.items[0].id);
        }
      } catch (err) {
        if (active) {
          setError(err.message);
          if (/not signed|unauthorized/i.test(err.message)) {
            localStorage.removeItem(TOKEN_KEY);
            setToken("");
          }
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !selectedStore?.id) {
      setProducts([]);
      setOrders([]);
      return;
    }

    let active = true;
    (async () => {
      try {
        await refreshCatalog(token, selectedStore.id);
      } catch (err) {
        if (active) setError(err.message);
      }
    })();

    return () => {
      active = false;
    };
  }, [token, selectedStore?.id]);

  async function handleAuth(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data =
        mode === "login"
          ? await login({ email: userEmail, password })
          : await register({ email: userEmail, password, displayName });
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setMessage(mode === "login" ? "Signed in." : "Account created.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateStore(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await createStore(token, {
        name: storeName,
        slug: storeSlug,
        supportEmail: userEmail,
      });
      setStores((current) => [data.store, ...current]);
      setSelectedStoreId(data.store.id);
      setMessage(`Store ${data.store.slug} created.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function startEditProduct(product) {
    setEditingProductId(product.id);
    setProductTitle(product.title);
    setProductPrice(String((Number(product.priceCents) || 0) / 100));
    setProductStock(String(product.stock ?? 0));
    setProductStatus(product.status || "draft");
    setActiveTab("catalog");
  }

  function resetProductForm() {
    setEditingProductId("");
    setProductTitle("Stainless Steel Bottle");
    setProductPrice("12.99");
    setProductStock("50");
    setProductStatus("active");
  }

  async function handleSaveProduct(event) {
    event.preventDefault();
    if (!selectedStore?.id) {
      setError("Create a store first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const priceCents = Math.round(Number(productPrice) * 100);
      const payload = {
        title: productTitle,
        description: "Managed from seller admin.",
        status: productStatus,
        priceCents,
        stock: Number(productStock) || 0,
      };

      if (editingProductId) {
        const data = await updateProduct(token, selectedStore.id, editingProductId, payload);
        setProducts((current) =>
          current.map((item) => (item.id === editingProductId ? data.product : item)),
        );
        setMessage(`Product ${data.product.title} updated.`);
      } else {
        const data = await createProduct(token, selectedStore.id, payload);
        setProducts((current) => [data.product, ...current]);
        setMessage(`Product ${data.product.title} created.`);
      }
      resetProductForm();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteProduct(productId) {
    if (!selectedStore?.id) return;
    setBusy(true);
    setError("");
    try {
      await deleteProduct(token, selectedStore.id, productId);
      setProducts((current) => current.filter((item) => item.id !== productId));
      if (editingProductId === productId) {
        resetProductForm();
      }
      setMessage("Product deleted.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateContent(productId) {
    if (!selectedStore?.id) return;
    setBusy(true);
    setError("");
    try {
      const data = await generateProductContent(token, selectedStore.id, productId, {
        apply: true,
      });
      setProducts((current) =>
        current.map((item) => (item.id === productId ? data.product : item)),
      );
      if (editingProductId === productId) {
        setProductTitle(data.product.title);
      }
      const source = data.generated?.generationMeta?.source || "ai";
      setMessage(`AI content applied (${source}).`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateDemoOrder() {
    if (!selectedStore?.id) return;
    const activeProduct = products.find((item) => item.status === "active") || products[0];
    if (!activeProduct) {
      setError("Add a product before creating a demo order.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await createOrder(token, selectedStore.id, {
        email: "buyer@example.com",
        status: "paid",
        items: [{ productId: activeProduct.id, quantity: 1 }],
        shippingAddress: {
          name: "Demo Buyer",
          country: "US",
          city: "Austin",
          line1: "100 Main St",
        },
      });
      setOrders((current) => [data.order, ...current]);
      setActiveTab("orders");
      setMessage(`Demo order ${data.order.orderNo} created.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleFulfillOrder(orderId) {
    if (!selectedStore?.id) return;
    setBusy(true);
    setError("");
    try {
      const draft = trackingDrafts[orderId] || {};
      const data = await fulfillOrder(token, selectedStore.id, orderId, {
        carrier: draft.carrier || "DHL",
        trackingNo: draft.trackingNo || `TRK${Date.now().toString().slice(-8)}`,
      });
      setOrders((current) => current.map((item) => (item.id === orderId ? data.order : item)));
      setMessage(`Order ${data.order.orderNo} fulfilled.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelOrder(orderId) {
    if (!selectedStore?.id) return;
    setBusy(true);
    setError("");
    try {
      const data = await cancelOrder(token, selectedStore.id, orderId);
      setOrders((current) => current.map((item) => (item.id === orderId ? data.order : item)));
      setMessage(`Order ${data.order.orderNo} cancelled.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleSignOut() {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setStores([]);
    setProducts([]);
    setOrders([]);
  }

  if (!token) {
    return (
      <div className="auth-page">
        <form className="panel auth-card" onSubmit={handleAuth}>
          <p className="eyebrow">Independent Store SaaS</p>
          <h1>Seller Admin</h1>
          <p className="muted">Open an English storefront and manage products & orders.</p>

          <div className="tabs">
            <button type="button" className={mode === "login" ? "is-active" : ""} onClick={() => setMode("login")}>
              Sign in
            </button>
            <button
              type="button"
              className={mode === "register" ? "is-active" : ""}
              onClick={() => setMode("register")}
            >
              Register
            </button>
          </div>

          {mode === "register" ? (
            <label className="field">
              <span>Display name</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          ) : null}

          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              value={userEmail}
              onChange={(e) => setUserEmail(e.target.value)}
              placeholder="seller@example.com"
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error ? <p className="error">{error}</p> : null}
          {message ? <p className="success">{message}</p> : null}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Working..." : mode === "login" ? "Sign in" : "Create account"}
          </button>
          <p className="muted tiny">API: {apiBaseUrl}</p>
        </form>
      </div>
    );
  }

  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>Seller Admin</strong>
          <span>Products & orders</span>
        </div>
        <div className="side-nav">
          <button
            type="button"
            className={activeTab === "catalog" ? "is-active" : ""}
            onClick={() => setActiveTab("catalog")}
          >
            Catalog
          </button>
          <button
            type="button"
            className={activeTab === "orders" ? "is-active" : ""}
            onClick={() => setActiveTab("orders")}
          >
            Orders
          </button>
        </div>
        <div className="side-meta">
          <span>Signed in</span>
          <button type="button" className="linkish" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="content">
        <header className="top">
          <div>
            <p className="eyebrow">Commerce API</p>
            <h1>{activeTab === "orders" ? "Orders" : "Catalog"}</h1>
          </div>
          {selectedStore ? (
            <a
              className="ghost"
              href={`http://127.0.0.1:3000/s/${selectedStore.slug}`}
              target="_blank"
              rel="noreferrer"
            >
              Preview storefront
            </a>
          ) : null}
        </header>

        {error ? <p className="error">{error}</p> : null}
        {message ? <p className="success">{message}</p> : null}

        <section className="panel store-bar">
          <div className="list horizontal">
            {stores.map((store) => (
              <button
                key={store.id}
                type="button"
                className={`store-chip ${selectedStore?.id === store.id ? "is-active" : ""}`}
                onClick={() => setSelectedStoreId(store.id)}
              >
                <strong>{store.name}</strong>
                <span>{store.slug}</span>
              </button>
            ))}
          </div>
          <form className="inline-form" onSubmit={handleCreateStore}>
            <input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="Store name" />
            <input value={storeSlug} onChange={(e) => setStoreSlug(e.target.value)} placeholder="slug" />
            <button className="primary" type="submit" disabled={busy}>
              Create store
            </button>
          </form>
        </section>

        {activeTab === "catalog" ? (
          <>
            <section className="grid-2">
              <form className="panel" onSubmit={handleSaveProduct}>
                <h2>{editingProductId ? "Edit product" : "Add product"}</h2>
                <p className="muted">
                  Current store: <strong>{selectedStore?.name || "none"}</strong>
                </p>
                <label className="field">
                  <span>Title</span>
                  <input value={productTitle} onChange={(e) => setProductTitle(e.target.value)} required />
                </label>
                <div className="row">
                  <label className="field">
                    <span>Price (USD)</span>
                    <input value={productPrice} onChange={(e) => setProductPrice(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Stock</span>
                    <input value={productStock} onChange={(e) => setProductStock(e.target.value)} />
                  </label>
                </div>
                <label className="field">
                  <span>Status</span>
                  <select value={productStatus} onChange={(e) => setProductStatus(e.target.value)}>
                    <option value="draft">draft</option>
                    <option value="active">active</option>
                  </select>
                </label>
                <div className="row">
                  <button className="primary" type="submit" disabled={busy || !selectedStore}>
                    {editingProductId ? "Update product" : "Create product"}
                  </button>
                  {editingProductId ? (
                    <button type="button" className="ghost" onClick={resetProductForm}>
                      Cancel edit
                    </button>
                  ) : null}
                </div>
              </form>

              <section className="panel">
                <h2>Catalog</h2>
                {products.length === 0 ? <p className="muted">No products in this store.</p> : null}
                <div className="product-table">
                  {products.map((product) => (
                    <div key={product.id} className="product-row">
                      <div>
                        <strong>{product.title}</strong>
                        <span className="muted">
                          /{product.handle} · {product.status}
                        </span>
                      </div>
                      <div className="row-actions">
                        <span>
                          {money(product.priceCents, selectedStore?.currency || "USD")} · stock{" "}
                          {product.stock}
                        </span>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => handleGenerateContent(product.id)}
                        >
                          AI fill
                        </button>
                        <button type="button" className="ghost" onClick={() => startEditProduct(product)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ghost danger"
                          onClick={() => handleDeleteProduct(product.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </section>
          </>
        ) : (
          <section className="panel">
            <div className="panel-top-row">
              <div>
                <h2>Orders</h2>
                <p className="muted tiny">
                  {orderCounts.pending_payment || 0} pending · {orderCounts.paid || 0} paid ·{" "}
                  {orderCounts.fulfilled || 0} fulfilled
                </p>
              </div>
              <button type="button" className="primary" disabled={busy || !selectedStore} onClick={handleCreateDemoOrder}>
                Create demo paid order
              </button>
            </div>

            <div className="filter-row" role="tablist" aria-label="Order status filter">
              {ORDER_FILTERS.map((filter) => {
                const count = orderCounts[filter.key] || 0;
                return (
                  <button
                    key={filter.key}
                    type="button"
                    className={`filter-chip ${orderFilter === filter.key ? "is-active" : ""}`}
                    onClick={() => setOrderFilter(filter.key)}
                  >
                    <span>{filter.label}</span>
                    <strong>{count}</strong>
                  </button>
                );
              })}
            </div>

            {filteredOrders.length === 0 ? (
              <p className="muted">
                {orders.length === 0
                  ? "No orders yet."
                  : `No orders in “${ORDER_FILTERS.find((item) => item.key === orderFilter)?.label || orderFilter}”.`}
              </p>
            ) : null}

            <div className="order-list">
              {filteredOrders.map((order) => {
                const draft = trackingDrafts[order.id] || {};
                const status = orderStatusMeta(order.status);
                const address = order.shippingAddress || {};
                return (
                  <article key={order.id} className={`order-card tone-${status.tone}`}>
                    <div className="order-head">
                      <div>
                        <div className="order-title-row">
                          <strong>{order.orderNo}</strong>
                          <span className={`status-badge tone-${status.tone}`}>{status.label}</span>
                        </div>
                        <span className="muted">
                          {order.email} · {formatDateTime(order.createdAt)}
                        </span>
                      </div>
                      <strong>{money(order.totalCents, order.currency || "USD")}</strong>
                    </div>

                    <div className="order-meta">
                      <div>
                        <span className="meta-label">Items</span>
                        <p>
                          {order.items?.length
                            ? order.items.map((item) => `${item.title} ×${item.quantity}`).join(" · ")
                            : "No line items"}
                        </p>
                      </div>
                      <div>
                        <span className="meta-label">Ship to</span>
                        <p>
                          {[address.name, address.line1, address.city, address.country]
                            .filter(Boolean)
                            .join(", ") || "—"}
                        </p>
                      </div>
                    </div>

                    {order.status === "paid" ? (
                      <div className="fulfill-row">
                        <input
                          placeholder="Carrier"
                          value={draft.carrier || ""}
                          onChange={(e) =>
                            setTrackingDrafts((current) => ({
                              ...current,
                              [order.id]: { ...draft, carrier: e.target.value },
                            }))
                          }
                        />
                        <input
                          placeholder="Tracking no"
                          value={draft.trackingNo || ""}
                          onChange={(e) =>
                            setTrackingDrafts((current) => ({
                              ...current,
                              [order.id]: { ...draft, trackingNo: e.target.value },
                            }))
                          }
                        />
                        <button type="button" className="primary" onClick={() => handleFulfillOrder(order.id)}>
                          Mark fulfilled
                        </button>
                      </div>
                    ) : null}

                    {["pending_payment", "payment_failed"].includes(order.status) ? (
                      <div className="fulfill-row">
                        <button
                          type="button"
                          className="ghost danger"
                          disabled={busy}
                          onClick={() => handleCancelOrder(order.id)}
                        >
                          Cancel unpaid order
                        </button>
                      </div>
                    ) : null}

                    {order.shipments?.[0] ? (
                      <p className="muted ship-line">
                        Shipped via {order.shipments[0].carrier || "carrier"} ·{" "}
                        {order.shipments[0].trackingNo || "no tracking"} ·{" "}
                        {formatDateTime(order.shipments[0].shippedAt || order.fulfilledAt)}
                      </p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
