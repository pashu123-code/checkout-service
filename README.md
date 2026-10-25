# Checkout Service

Backend for a small online store: carts, checkout, inventory, and a reward
coupon unlocked by every *n*th successfully placed order.

The endpoints themselves are simple. The work is in keeping the data
correct when requests are retried, run at the same time, or fail partway
through:

- stock is never oversold, even when many customers check out the last unit at once;
- retrying a checkout never creates a second order or charges stock twice;
- a coupon is used at most once, and is never lost by a checkout that fails;
- money is exact (integer cents) and the admin report always adds up.

How each of these is enforced, and the trade-offs, are in
[DECISIONS.md](DECISIONS.md).

## Quick start

Requires **Node.js 20 or newer**. No database or other services.

```bash
npm install
npm start          # http://localhost:3000
npm test           # all tests, including the concurrency tests
npm run typecheck
```

`npm run dev` restarts the server when files change.

### Configuration

All optional, set as environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NTH_ORDER` | `5` | Every *n*th placed order unlocks one coupon |
| `DISCOUNT_PERCENT` | `10` | Coupon discount, whole percent from 1 to 100 |
| `PAYMENT_DELAY_MS` | `150` | Simulated payment time, so concurrent checkouts overlap |

Example: `NTH_ORDER=2 DISCOUNT_PERCENT=25 npm start`.

State is in memory and resets when the server restarts.

### Seed products

| ID | Name | Price | Stock |
|---|---|---:|---:|
| `p_tshirt` | Cotton T-Shirt | $19.99 | 100 |
| `p_mug` | Ceramic Mug | $12.50 | 50 |
| `p_hoodie` | Zip Hoodie | $49.99 | 25 |
| `p_cap` | Baseball Cap | $15.99 | 40 |
| `p_stickers` | Sticker Pack | $2.99 | 500 |
| `p_sneakers` | Limited Edition Sneakers | $129.99 | **2** |

## Try it

[`requests.http`](requests.http) has every request below, ready to run with
the VS Code REST Client or JetBrains HTTP Client. With curl (and `jq`):

```bash
# Create a cart and add items
CART=$(curl -s -X POST localhost:3000/carts | jq -r .id)
curl -s -X PUT localhost:3000/carts/$CART/items/p_tshirt \
  -H 'Content-Type: application/json' -d '{"quantity": 2}'

# Check out. Sending the same request again returns the same order.
curl -s -X POST localhost:3000/carts/$CART/checkout \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: my-first-order' -d '{}'

# Admin: issue a coupon once a milestone is reached, then view the report
curl -s -X POST localhost:3000/admin/coupons
curl -s localhost:3000/admin/report
```

## API

### Conventions

- JSON in and out. Money is always an **integer number of cents** (`1999` = $19.99).
- Request bodies are strict: unknown fields are rejected, so a typo cannot be silently ignored.
- Routes under `/admin` are administrative. Authentication is out of scope;
  in production they would require an admin role.
- Every error has the same shape. Branch on `code`; `message` is for people
  and may change.

```json
{ "error": { "code": "INSUFFICIENT_INVENTORY", "message": "…", "details": { "items": [ … ] } } }
```

### Endpoints

| Method | Path | Success | Purpose |
|---|---|---|---|
| GET | `/products` | 200 | List products with the quantity available now |
| POST | `/carts` | 201 | Create an empty cart |
| GET | `/carts/:cartId` | 200 | View a cart with current prices and totals |
| PUT | `/carts/:cartId/items/:productId` | 200 | Add a product or change its quantity |
| DELETE | `/carts/:cartId/items/:productId` | 200 | Remove a product |
| POST | `/carts/:cartId/checkout` | 201 | Place an order (requires `Idempotency-Key`) |
| GET | `/orders/:orderId` | 200 | View an order |
| POST | `/admin/coupons` | 201 | Issue a coupon for the next unrewarded milestone |
| GET | `/admin/coupons` | 200 | List coupons and their status |
| GET | `/admin/orders` | 200 | List placed orders |
| GET | `/admin/report` | 200 | Sales and coupon summary |
| PATCH | `/admin/products/:productId` | 200 | Change name, price, or stock |

#### `PUT /carts/:cartId/items/:productId`

Body: `{ "quantity": 2 }`, an integer from 1 to 1000. Sets the quantity
(it does not add to it), so repeating the request is harmless. Returns the cart:

```json
{
  "id": "cart_d270b805-…",
  "status": "OPEN",
  "orderId": null,
  "items": [
    { "productId": "p_tshirt", "name": "Cotton T-Shirt", "unitPriceCents": 1999,
      "quantity": 2, "lineTotalCents": 3998, "availableQuantity": 100 }
  ],
  "itemCount": 2,
  "subtotalCents": 3998,
  "createdAt": "2026-10-25T12:13:34.247Z",
  "updatedAt": "2026-10-25T12:13:34.611Z"
}
```

Cart prices are live. The price actually charged is fixed at checkout.
Errors: `422 VALIDATION_FAILED`, `404 CART_NOT_FOUND`, `404 PRODUCT_NOT_FOUND`,
`409 INSUFFICIENT_INVENTORY` (more than is available), `409 CART_NOT_OPEN`.

`DELETE` returns the cart too. Removing a product that is not in the cart is a no-op.

#### `POST /carts/:cartId/checkout`

Headers: **`Idempotency-Key`** (required, 1–255 characters). Use a new key for
each checkout attempt and the same key when retrying it.

Body (all optional):

```json
{ "couponCode": "SAVE10-SAWHCURN", "expectedTotalCents": 4500 }
```

`expectedTotalCents` makes checkout fail rather than charge any other amount,
for example if a price changed after the customer looked at the cart.

Returns `201` with the order and an `Idempotent-Replayed: true|false` header:

```json
{
  "id": "ord_faa8d281-…",
  "number": 3,
  "cartId": "cart_ce5a1cee-…",
  "lines": [
    { "productId": "p_hoodie", "name": "Zip Hoodie", "unitPriceCents": 4999,
      "quantity": 1, "lineTotalCents": 4999 }
  ],
  "subtotalCents": 4999,
  "discountPercent": 10,
  "discountCents": 499,
  "totalCents": 4500,
  "couponCode": "SAVE10-SAWHCURN",
  "paymentId": "pay_00357774-…",
  "placedAt": "2026-10-25T12:13:35.466Z"
}
```

The order keeps its own copy of names and prices, so later product changes do
not alter it. The discount is applied once to the subtotal and rounded down to
the cent.

Retry behaviour:

| Situation | Result |
|---|---|
| Same key, same body, first request finished | `201`, the same order, `Idempotent-Replayed: true` |
| Same key, same body, first request still running | Waits for it, then returns the same order |
| Same key, different cart or body | `422 IDEMPOTENCY_KEY_REUSED` |
| Same key after a failed attempt (e.g. declined) | Runs again; failures leave nothing behind |
| New key on a cart that was already checked out | `409 CART_ALREADY_CHECKED_OUT` with the `orderId` |

#### `POST /admin/coupons`

No body. Issues one coupon for the oldest milestone (order *n*, 2*n*, 3*n*, …)
that does not have one yet:

```json
{
  "code": "SAVE10-SAWHCURN",
  "percent": 10,
  "milestone": 2,
  "status": "AVAILABLE",
  "reservedByCartId": null,
  "redeemedByOrderId": null,
  "createdAt": "2026-10-25T12:13:35.130Z",
  "redeemedAt": null
}
```

If no milestone is waiting, returns `409 NO_ELIGIBLE_MILESTONE` with
`placedOrders`, `nextMilestone` and `ordersUntilNextMilestone`.

A coupon is `AVAILABLE`, then `RESERVED` while a checkout using it waits for
payment, then `REDEEMED`. If that checkout fails it goes back to `AVAILABLE`.

#### `GET /admin/report`

```json
{
  "placedOrders": 3,
  "itemsPurchased": [
    { "productId": "p_tshirt", "name": "Cotton T-Shirt", "quantity": 2, "grossRevenueCents": 3998 },
    { "productId": "p_hoodie", "name": "Zip Hoodie", "quantity": 1, "grossRevenueCents": 4999 }
  ],
  "totalItemsPurchased": 5,
  "grossRevenueCents": 11846,
  "totalDiscountCents": 499,
  "netRevenueCents": 11347,
  "coupons": { "generated": 1, "available": 0, "reserved": 0, "redeemed": 1 },
  "milestones": { "nthOrder": 2, "discountPercent": 10, "nextMilestone": 4, "couponAvailableToGenerate": false }
}
```

(`itemsPurchased` lists every product, including those with zero sales.)

Computed from the stored orders and coupons on each request, so it matches
`GET /admin/orders` and `GET /admin/coupons`, and reading it never changes
anything. Checkouts still waiting for payment are not counted.

#### `PATCH /admin/products/:productId`

Body: any of `{ "name": "…", "priceCents": 2500, "stock": 10 }`. `stock` is the
absolute number of units on hand. Returns the product including `stock` and
`reserved`. Stock cannot be set below the units held by pending checkouts
(`409 STOCK_BELOW_RESERVED`).

### Error codes

| Status | Code | Meaning | Retry? |
|---|---|---|---|
| 400 | `INVALID_JSON` | Body is not valid JSON | Fix request |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Checkout sent without `Idempotency-Key` | Fix request |
| 402 | `PAYMENT_DECLINED` | Payment refused; nothing charged, cart open again | Yes, same key |
| 404 | `ROUTE_NOT_FOUND`, `CART_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ORDER_NOT_FOUND` | Unknown route or resource | No |
| 409 | `CART_NOT_OPEN` | Cart is checking out or checked out; it cannot change | No |
| 409 | `CART_ALREADY_CHECKED_OUT` | Cart already has an order (`details.orderId`) | No |
| 409 | `CHECKOUT_IN_PROGRESS` | This cart's checkout is still paying | Yes, same key |
| 409 | `INSUFFICIENT_INVENTORY` | Not enough stock; `details.items` lists shortfalls | After changing the cart |
| 409 | `TOTAL_MISMATCH` | Total differs from `expectedTotalCents` | After confirming the new total |
| 409 | `COUPON_IN_USE` | Another pending checkout holds the coupon | Yes, shortly |
| 409 | `COUPON_ALREADY_REDEEMED` | Coupon was used by another order | No |
| 409 | `NO_ELIGIBLE_MILESTONE` | No milestone is waiting for a coupon | After more orders |
| 409 | `STOCK_BELOW_RESERVED` | Admin stock change below held units | After checkouts finish |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 16 KB | Fix request |
| 422 | `VALIDATION_FAILED` | Body fields invalid; `details` lists each field | Fix request |
| 422 | `CART_EMPTY` | Checkout of an empty cart | After adding items |
| 422 | `COUPON_NOT_FOUND` | No coupon with that code | No |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Key already used for a different request | Use a new key |
| 500 | `INTERNAL_ERROR` | Unexpected failure | Yes |

## Project layout

```
src/
  domain/money.ts       integer-cents arithmetic and validation
  domain/pricing.ts     the one place cart and order totals are calculated
  services/carts.ts     cart rules
  services/checkout.ts  reserve → pay → commit/release
  services/idempotency.ts  run-once-per-key for checkout retries
  services/coupons.ts   milestone coupons
  services/report.ts    admin summary
  payment.ts            payment interface and the fake gateway
  store.ts              in-memory state and types
  app.ts                HTTP routes and request validation
tests/                  unit, HTTP and concurrency tests
```

## Tests

`npm test` runs every test. Besides the normal cases they cover:

- **Concurrency:** ten checkouts racing for three units; many checkouts racing
  for one coupon; parallel coupon generation; a random mix of quantities and
  payment failures, after which stock always matches the orders.
- **Retries:** the same checkout sent eight times at once creates one order;
  replays after success; reused keys; retries after a decline.
- **Failures:** a declined payment or failed check never holds stock or uses up a coupon.
- **Money:** rounding checked against exact integer maths for every percent,
  overflow limits, and totals that never go negative.
- **Report:** reconciles with the orders and coupons the API returns, and
  repeated reads change nothing.

Tests that need two requests to overlap use a payment gateway the test
controls, pausing a checkout mid-payment instead of relying on timing.
