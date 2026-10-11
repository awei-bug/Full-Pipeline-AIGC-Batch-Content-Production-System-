import { useEffect, useMemo, useState } from "react";

import {
  addCartItem,
  apiBaseUrl,
  capturePaypalPayment,
  checkoutCart,
  createCart,
  createPaypalPayment,
  fetchOrder,
  fetchProduct,
  fetchStorefront,
  getCart,
  removeCartItem,
  updateCartItem,
} from "./api.js";

function money(cents, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format((Number(cents) || 0) / 100);
}

function cartStorageKey(slug) {
  return `storefront_cart_${slug}`;
}

function parsePath() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean);

  if (parts[0] === "s" && parts[1]) {
    if (parts[2] === "cart") {
      return { view: "cart", slug: parts[1], handle: "" };
    }
    if (parts[2] === "checkout") {
      return { view: "checkout", slug: parts[1], handle: "" };
    }
    if (parts[2] === "order" && parts[3]) {
      return { view: "success", slug: parts[1], handle: parts[3] };
    }
    if (parts[2] === "products" && parts[3]) {
      return { view: "product", slug: parts[1], handle: parts[3] };
    }
    return { view: "store", slug: parts[1], handle: "" };
  }

  return { view: "home", slug: "", handle: "" };
}

export function App() {
  const [route, setRoute] = useState(() => parsePath());
  const [payload, setPayload] = useState(null);
  const [cart, setCart] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [demoSlug, setDemoSlug] = useState("nordic-home");
  const [checkoutEmail, setCheckoutEmail] = useState("");
  const [checkoutName, setCheckoutName] = useState("");
  const [checkoutCountry, setCheckoutCountry] = useState("US");
  const [checkoutCity, setCheckoutCity] = useState("");
  const [checkoutLine1, setCheckoutLine1] = useState("");
  const [lastOrder, setLastOrder] = useState(null);

  useEffect(() => {
    function onPopState() {
      setRoute(parsePath());
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (route.view === "home") {
      setPayload(null);
      setError("");
      return;
    }

    let active = true;
    setLoading(true);
    setError("");

    (async () => {
      try {
        if (route.view === "success") {
          const params = new URLSearchParams(window.location.search);
          const paypalFlag = params.get("paypal");
          const token = params.get("token");

          if (paypalFlag === "return" && token) {
            try {
              await capturePaypalPayment({ paypalOrderId: token });
            } catch (captureError) {
              if (active) setError(captureError.message);
            }
          }

          const orderData = await fetchOrder(route.slug, route.handle);
          if (!active) return;
          setPayload({ store: orderData.store });
          setLastOrder(orderData.order);
          setCart(null);
          return;
        }

        const data =
          route.view === "product"
            ? await fetchProduct(route.slug, route.handle)
            : await fetchStorefront(route.slug);
        if (!active) return;
        setPayload(data);

        const storedCartId = localStorage.getItem(cartStorageKey(route.slug));
        if (storedCartId) {
          try {
            const cartData = await getCart(storedCartId);
            if (active && cartData.cart?.status === "open") {
              setCart(cartData.cart);
            } else if (active) {
              localStorage.removeItem(cartStorageKey(route.slug));
              setCart(null);
            }
          } catch {
            if (active) {
              localStorage.removeItem(cartStorageKey(route.slug));
              setCart(null);
            }
          }
        } else if (active) {
          setCart(null);
        }
      } catch (err) {
        if (active) {
          setPayload(null);
          setError(err.message);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [route.view, route.slug, route.handle]);

  function navigate(path) {
    window.history.pushState({}, "", path);
    setRoute(parsePath());
    setNotice("");
  }

  async function ensureCart(store) {
    if (cart?.id && cart.storeId === store.id && cart.status === "open") {
      return cart;
    }
    const data = await createCart({ storeId: store.id, storeSlug: store.slug });
    localStorage.setItem(cartStorageKey(store.slug), data.cart.id);
    setCart(data.cart);
    return data.cart;
  }

  async function handleAddToCart(store, product, quantity = 1) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const current = await ensureCart(store);
      const data = await addCartItem(current.id, {
        productId: product.id,
        quantity,
      });
      setCart(data.cart);
      setNotice(`${product.title} added to cart.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateQty(itemId, quantity) {
    if (!cart?.id) return;
    setBusy(true);
    setError("");
    try {
      const data = await updateCartItem(cart.id, itemId, quantity);
      setCart(data.cart);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveItem(itemId) {
    if (!cart?.id) return;
    setBusy(true);
    setError("");
    try {
      const data = await removeCartItem(cart.id, itemId);
      setCart(data.cart);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckout(event) {
    event.preventDefault();
    if (!cart?.id) return;
    setBusy(true);
    setError("");
    try {
      const data = await checkoutCart(cart.id, {
        email: checkoutEmail,
        shippingAddress: {
          name: checkoutName,
          country: checkoutCountry,
          city: checkoutCity,
          line1: checkoutLine1,
        },
      });
      setLastOrder(data.order);
      setCart(data.cart);
      localStorage.removeItem(cartStorageKey(route.slug));

      const paymentData = await createPaypalPayment({
        orderId: data.order.id,
        storeSlug: route.slug,
      });
      setLastOrder(paymentData.order || data.order);

      if (paymentData.approveUrl) {
        window.location.href = paymentData.approveUrl;
        return;
      }

      navigate(`/s/${route.slug}/order/${data.order.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePayNow() {
    if (!lastOrder?.id) return;
    setBusy(true);
    setError("");
    try {
      const paymentData = await createPaypalPayment({
        orderId: lastOrder.id,
        storeSlug: route.slug,
      });
      if (paymentData.approveUrl) {
        window.location.href = paymentData.approveUrl;
        return;
      }
      setError("PayPal approve URL missing");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const store = payload?.store;
  const products = useMemo(() => payload?.products || [], [payload]);
  const product = payload?.product;
  const cartCount = cart?.itemCount || 0;

  function StoreHeader({ title, subtitle }) {
    return (
      <header className="store-header">
        <div>
          <button type="button" className="brand-link" onClick={() => navigate(`/s/${route.slug}`)}>
            {title}
          </button>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>
        <div className="header-actions">
          <span className="pill">{store?.currency || "USD"}</span>
          <button type="button" className="ghost" onClick={() => navigate(`/s/${route.slug}/cart`)}>
            Cart ({cartCount})
          </button>
        </div>
      </header>
    );
  }

  if (route.view === "home") {
    return (
      <div className="landing">
        <div className="hero panel">
          <p className="eyebrow">Global English storefront</p>
          <h1>Independent Store SaaS</h1>
          <p className="lead">
            Browse products, add to cart, and checkout. PayPal capture comes next; checkout now creates a
            pending_payment order.
          </p>
          <form
            className="slug-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (demoSlug.trim()) {
                navigate(`/s/${demoSlug.trim()}`);
              }
            }}
          >
            <label>
              <span>Store slug</span>
              <input value={demoSlug} onChange={(e) => setDemoSlug(e.target.value)} />
            </label>
            <button type="submit" className="primary">
              Open store
            </button>
          </form>
          <p className="muted">API: {apiBaseUrl}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="state">Loading store…</div>;
  }

  if (error && !store && route.view !== "success") {
    return (
      <div className="state">
        <strong>Could not load store</strong>
        <p>{error}</p>
        <button type="button" className="primary" onClick={() => navigate("/")}>
          Back
        </button>
      </div>
    );
  }

  if (route.view === "success") {
    const status = lastOrder?.status || "pending_payment";
    const isPaid = ["paid", "fulfilled", "completed"].includes(status);
    return (
      <div className="store-shell">
        <StoreHeader title={store?.name || "Store"} subtitle="Order status" />
        {error ? <p className="error">{error}</p> : null}
        <section className="panel success-panel">
          <h1>{isPaid ? "Payment received. Thank you!" : "Order created — complete PayPal payment"}</h1>
          <p className="muted">
            Order: <strong>{lastOrder?.orderNo || route.handle}</strong> · Status:{" "}
            <strong>{status}</strong>
          </p>
          <p>
            Total:{" "}
            <strong>
              {money(lastOrder?.totalCents || 0, lastOrder?.currency || store?.currency || "USD")}
            </strong>
          </p>
          {!isPaid ? (
            <button type="button" className="primary" disabled={busy} onClick={handlePayNow}>
              {busy ? "Redirecting..." : "Pay with PayPal"}
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={() => navigate(`/s/${route.slug}`)}>
            Continue shopping
          </button>
        </section>
      </div>
    );
  }

  if (route.view === "cart" && store) {
    return (
      <div className="store-shell">
        <StoreHeader title={store.name} subtitle="Your cart" />
        {error ? <p className="error">{error}</p> : null}
        <section className="panel">
          {!cart?.items?.length ? (
            <div className="empty">
              <p>Your cart is empty.</p>
              <button type="button" className="primary" onClick={() => navigate(`/s/${store.slug}`)}>
                Browse products
              </button>
            </div>
          ) : (
            <>
              <div className="cart-list">
                {cart.items.map((item) => (
                  <div key={item.id} className="cart-row">
                    <div>
                      <strong>{item.title}</strong>
                      <p className="muted">{money(item.unitPriceCents, cart.currency)} each</p>
                    </div>
                    <div className="cart-actions">
                      <input
                        type="number"
                        min="0"
                        value={item.quantity}
                        onChange={(e) => handleUpdateQty(item.id, Number(e.target.value))}
                      />
                      <span>{money(item.lineTotalCents, cart.currency)}</span>
                      <button type="button" className="ghost" onClick={() => handleRemoveItem(item.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="cart-summary">
                <div>
                  <span className="muted">Subtotal</span>
                  <strong>{money(cart.subtotalCents, cart.currency)}</strong>
                </div>
                <div>
                  <span className="muted">Shipping</span>
                  <strong>{money(cart.shippingCents, cart.currency)}</strong>
                </div>
                <div>
                  <span className="muted">Total</span>
                  <strong>{money(cart.totalCents, cart.currency)}</strong>
                </div>
              </div>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => navigate(`/s/${store.slug}/checkout`)}
              >
                Proceed to checkout
              </button>
            </>
          )}
        </section>
      </div>
    );
  }

  if (route.view === "checkout" && store) {
    return (
      <div className="store-shell">
        <StoreHeader title={store.name} subtitle="Checkout" />
        {error ? <p className="error">{error}</p> : null}
        <section className="grid-2">
          <form className="panel" onSubmit={handleCheckout}>
            <h2>Shipping details</h2>
            <label className="field">
              <span>Email</span>
              <input
                required
                type="email"
                value={checkoutEmail}
                onChange={(e) => setCheckoutEmail(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Full name</span>
              <input required value={checkoutName} onChange={(e) => setCheckoutName(e.target.value)} />
            </label>
            <label className="field">
              <span>Country</span>
              <input required value={checkoutCountry} onChange={(e) => setCheckoutCountry(e.target.value)} />
            </label>
            <label className="field">
              <span>City</span>
              <input value={checkoutCity} onChange={(e) => setCheckoutCity(e.target.value)} />
            </label>
            <label className="field">
              <span>Address line</span>
              <input value={checkoutLine1} onChange={(e) => setCheckoutLine1(e.target.value)} />
            </label>
            <button className="primary" type="submit" disabled={busy || !cart?.items?.length}>
              {busy ? "Redirecting to PayPal..." : "Pay with PayPal"}
            </button>
          </form>
          <section className="panel">
            <h2>Order summary</h2>
            {!cart?.items?.length ? (
              <p className="muted">Cart is empty.</p>
            ) : (
              cart.items.map((item) => (
                <div key={item.id} className="summary-row">
                  <span>
                    {item.title} × {item.quantity}
                  </span>
                  <strong>{money(item.lineTotalCents, cart.currency)}</strong>
                </div>
              ))
            )}
            <div className="summary-row total">
              <span>Total</span>
              <strong>{money(cart?.totalCents || 0, cart?.currency || store.currency)}</strong>
            </div>
          </section>
        </section>
      </div>
    );
  }

  if (route.view === "product" && product && store) {
    return (
      <div className="store-shell">
        <StoreHeader title={store.name} />
        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="success">{notice}</p> : null}
        <main className="product-detail panel">
          <div className="image-ph" />
          <div>
            <p className="eyebrow">Product</p>
            <h1>{product.title}</h1>
            <p className="price">{money(product.priceCents, store.currency)}</p>
            <p>{product.description || "No description yet."}</p>
            <p className="muted">Stock: {product.stock}</p>
            <div className="detail-actions">
              <button
                type="button"
                className="primary"
                disabled={busy || product.stock <= 0}
                onClick={() => handleAddToCart(store, product, 1)}
              >
                Add to cart
              </button>
              <button type="button" className="ghost" onClick={() => navigate(`/s/${store.slug}/cart`)}>
                View cart
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (store) {
    return (
      <div className="store-shell">
        <StoreHeader title={store.name} subtitle="English storefront" />
        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="success">{notice}</p> : null}
        <section className="product-grid">
          {products.length === 0 ? (
            <div className="panel empty">No published products yet.</div>
          ) : (
            products.map((item) => (
              <article key={item.id} className="product-card">
                <button
                  type="button"
                  className="product-main"
                  onClick={() => navigate(`/s/${store.slug}/products/${item.handle}`)}
                >
                  <div className="image-ph" />
                  <strong>{item.title}</strong>
                  <span>{money(item.priceCents, store.currency)}</span>
                </button>
                <button
                  type="button"
                  className="primary compact"
                  disabled={busy || item.stock <= 0}
                  onClick={() => handleAddToCart(store, item, 1)}
                >
                  Add to cart
                </button>
              </article>
            ))
          )}
        </section>
      </div>
    );
  }

  return <div className="state">Nothing to show.</div>;
}
