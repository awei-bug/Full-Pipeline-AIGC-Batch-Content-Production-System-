import assert from "node:assert/strict";
import test from "node:test";

import { createPool, hasDatabaseConfig } from "./lib/database.js";
import { PostgresCommerceRepository } from "./repositories/postgres-commerce-repository.js";

const canRun = hasDatabaseConfig(process.env);

test(
  "postgres repository supports register store product storefront path",
  { skip: canRun ? false : "PostgreSQL env not configured" },
  async () => {
    const pool = createPool(process.env);
    assert.ok(pool);

    // Ensure schema exists for this integration test.
    await pool.query("select 1 from commerce.users limit 1");
    await pool.query("select 1 from commerce.sessions limit 1");

    const repository = new PostgresCommerceRepository(pool);
    const suffix = Date.now().toString(36);
    const email = `seller_${suffix}@example.com`;
    const slug = `store-${suffix}`;

    const user = await repository.createUser({
      email,
      password: "password123",
      displayName: "PG Seller",
    });
    assert.equal(user.email, email);

    const session = await repository.createSession(user.id);
    const sessionUser = await repository.getUserBySessionToken(session.token);
    assert.equal(sessionUser.id, user.id);

    const store = await repository.createStore({
      ownerUserId: user.id,
      name: "PG Store",
      slug,
      supportEmail: email,
    });
    assert.equal(store.slug, slug);

    const stores = await repository.listStoresForUser(user.id);
    assert.ok(stores.some((item) => item.id === store.id));

    await repository.assertStoreMember(store.id, user.id);

    const product = await repository.createProduct({
      storeId: store.id,
      title: "PG Bottle",
      description: "From postgres repository test",
      status: "active",
      priceCents: 1999,
      stock: 5,
    });
    assert.equal(product.title, "PG Bottle");
    assert.equal(product.priceCents, 1999);

    const listed = await repository.listProductsByStore(store.id, { status: "active" });
    assert.ok(listed.some((item) => item.id === product.id));

    const fetched = await repository.getProductByHandle(store.id, product.handle);
    assert.equal(fetched.id, product.id);

    await pool.query(`delete from commerce.users where id = $1`, [user.id]);
    await pool.end();
  },
);
