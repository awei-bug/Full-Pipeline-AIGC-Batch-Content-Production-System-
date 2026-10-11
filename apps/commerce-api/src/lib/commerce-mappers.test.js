import assert from "node:assert/strict";
import test from "node:test";

import {
  isUniqueViolation,
  mapProductRow,
  mapStoreRow,
  mapUserRow,
  randomProductHandle,
  slugify,
} from "./commerce-mappers.js";

test("slugify normalizes store and product handles", () => {
  assert.equal(slugify("Nordic Home"), "nordic-home");
  assert.equal(slugify("  Food-Grade!! Bottle "), "food-grade-bottle");
  assert.equal(randomProductHandle("Stainless Bottle").startsWith("stainless-bottle"), true);
});

test("row mappers convert postgres snake_case fields", () => {
  const user = mapUserRow({
    id: "user_1",
    email: "a@b.com",
    display_name: "Ada",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(user, {
    id: "user_1",
    email: "a@b.com",
    displayName: "Ada",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const store = mapStoreRow({
    id: "store_1",
    owner_user_id: "user_1",
    name: "Nordic",
    slug: "nordic",
    currency: "USD",
    support_email: "s@n.com",
    logo_url: null,
    flat_shipping_cents: 500,
    status: "active",
    plan_code: "free",
    created_at: "t1",
    updated_at: "t2",
  });
  assert.equal(store.ownerUserId, "user_1");
  assert.equal(store.flatShippingCents, 500);

  const product = mapProductRow(
    {
      id: "prod_1",
      store_id: "store_1",
      title: "Bottle",
      handle: "bottle",
      description: "desc",
      status: "active",
      primary_image_url: null,
      metadata: {},
      created_at: "t1",
      updated_at: "t2",
    },
    [
      {
        id: "var_1",
        product_id: "prod_1",
        store_id: "store_1",
        sku: "SKU1",
        title: "Default",
        price_cents: 1299,
        compare_at_cents: null,
        stock: 8,
        created_at: "t1",
        updated_at: "t2",
      },
    ],
  );
  assert.equal(product.priceCents, 1299);
  assert.equal(product.stock, 8);
  assert.equal(product.variants[0].sku, "SKU1");
});

test("unique violation detector", () => {
  assert.equal(isUniqueViolation({ code: "23505" }), true);
  assert.equal(isUniqueViolation({ code: "42P01" }), false);
});
