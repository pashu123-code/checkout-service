# Design Decisions

This service keeps orders, inventory, coupons and reporting consistent while
requests are retried, overlap, or fail partway through. This document lists the
rules the system guarantees, the open questions in the brief and how I settled
them, the main design choices, and what I would change for production.

## 1. Invariants

| # | Invariant | Where it is enforced | Main tests |
|---|---|---|---|
| I1 | Stock is never oversold: `0 <= reserved <= stock` for every product | `reserve()` in `services/checkout.ts` checks availability before holding units; `commit()` moves held units to sold; `updateProduct()` refuses stock below `reserved` | `checkout.test.ts` › concurrent checkouts |
| I2 | A cart produces at most one order | Cart status `OPEN → CHECKING_OUT → CHECKED_OUT` (back to `OPEN` on failure); `reserve()` only accepts `OPEN` carts; cart edits require `OPEN` | `checkout.test.ts`, `idempotency.test.ts` |
| I3 | An `Idempotency-Key` produces at most one order, and every repeat gets that same order | `runIdempotent()` in `services/idempotency.ts` | `idempotency.test.ts` |
| I4 | A coupon is redeemed at most once and is never lost by a failed checkout | Coupon status `AVAILABLE → RESERVED → REDEEMED` (back to `AVAILABLE` on failure); `getRedeemableCoupon()` only accepts `AVAILABLE` | `coupons.test.ts` |
| I5 | At most one coupon per milestone, and coupons issued `<= floor(orders / n)` | `generateCoupon()` derives the next milestone from the number already issued | `coupons.test.ts` › generation |
| I6 | Money is exact; `0 <= discount <= subtotal`; `total = subtotal - discount >= 0` | `domain/money.ts`, `domain/pricing.ts` | `money.test.ts`, `pricing.test.ts` |
| I7 | An order never changes after it is placed | Lines (name, unit price, quantity) are copied when the checkout reserves; nothing writes to an order afterwards | `checkout.test.ts`, `report.test.ts` |
| I8 | A failed checkout leaves no trace | `reserve()` runs every check before changing any state; `release()` undoes exactly what `reserve()` did | decline / stock / coupon failure tests |
| I9 | The report reconciles with orders and coupons, and reading it changes nothing | `buildReport()` derives everything from stored orders and coupons on each call | `report.test.ts` |
| I10 | Order numbers run 1, 2, 3… with no gaps, counting only placed orders | Assigned in `commit()`, which only runs after payment succeeds | `coupons.test.ts` › failed checkouts don't count |

## 2. Ambiguities and the semantics I chose

| Question | Choice |
|---|---|
| What counts toward "every *n*th order"? | Every successfully placed order across the whole store, including discounted ones. Failed or abandoned checkouts do not count. |
| Who receives the coupon? | There are no customer accounts, so the coupon is a store-wide code issued to the administrator, who distributes it. It records the milestone that unlocked it. |
| Is the coupon issued automatically? | No. The brief says an administrator requests it, so `POST /admin/coupons` issues it. |
| Several milestones reached before anyone asks | Each request issues one coupon, for the oldest milestone without one. |
| What does `x` apply to? | The whole order subtotal, once, rounded down to the cent. `x` is a whole percent from 1 to 100, stored on the coupon when it is issued. |
| Price changes between adding to cart and checkout | The cart shows live prices. Checkout charges the price at the moment of checkout. A client can send `expectedTotalCents` to refuse any other amount (`409 TOTAL_MISMATCH`). |
| Stock changes between adding to cart and checkout | Stock is not held for carts. It is checked when adding (early feedback) and again at checkout (the real check). A shortfall returns `409 INSUFFICIENT_INVENTORY` listing each item, and the cart stays open to be fixed. |
| Invalid coupon at checkout | The checkout fails. Quietly charging full price when the customer asked for a discount is worse. |
| "Add an item" | `PUT` sets an absolute quantity, which covers both add and change and is safe to retry. Quantity 0 is invalid; `DELETE` removes. |
| Coupon expiry or per-customer limits | Not specified, not implemented. |
| Changing `n` or `x` at runtime | Not supported. Both are fixed at startup. Changing `n` midway would make milestone numbering ambiguous. |
| Zero-total orders (e.g. 100% coupon) | Placed without calling the payment provider; `paymentId` is `null`. |
| "Available" coupons in the report | Only `AVAILABLE`. Coupons held by a pending checkout are reported separately as `reserved`. |

## 3. Material decisions

## Decision: Reserve, pay, then commit or release

**Context:** Checkout must not oversell, double-charge stock, or lose a coupon, even when requests overlap. In Node.js a block of synchronous code always runs to completion before any other request is handled. So a checkout with no `await` could never interleave with another one, and its concurrency guarantees would be trivially true and untested.

**Options considered:**
- A: Fully synchronous checkout, treating success as payment. Correct, but proves nothing about overlapping requests.
- B: Check stock, await payment, then decrement. Two requests can both pass the check while the first is paying, which oversells.
- C: An async mutex per product or per cart.
- D: Reserve synchronously, await payment, then commit or release synchronously.

**Choice:** D, with a `PaymentGateway` interface and a fake gateway that adds latency and can be told to decline.

**Why:** The reserve step validates everything and then holds stock, the coupon and the cart in one synchronous block, so nothing can see a half-done state. The only `await` is the payment, and while it is pending other requests see the held resources. This maps directly onto a database design (section 8), whereas an in-process mutex (C) does not survive a second server instance.

**Consequences:** A checkout that finds stock or a coupon held by a pending payment gets an immediate conflict instead of waiting. That is simpler and more predictable, but a customer can be told "in use" by a checkout that later fails. `COUPON_IN_USE` is therefore documented as retryable.

## Decision: Idempotency-Key header, sharing the in-flight result

**Context:** Clients retry checkouts after timeouts. A retry must return the original order, not create a second one or fail confusingly.

**Options considered:**
- A: Use the cart as the natural key: checking out an already checked-out cart returns its order. This cannot tell a retry apart from a genuinely new attempt with a different coupon.
- B: Require an `Idempotency-Key`. Return `409` to duplicates that arrive while the first is still running.
- C: Require an `Idempotency-Key`. Duplicates that arrive while the first is running wait for it and get the same result.
- D: Cache every outcome for a key, including failures (as Stripe does).

**Choice:** C, keeping only successful results. The key is bound to a fingerprint of the request (cart, normalised coupon, expected total); reusing it for a different request is `422 IDEMPOTENCY_KEY_REUSED`.

**Why:** With C, a double-click or an aggressive retry gets the right answer with no extra round trip. Failed checkouts leave nothing behind (I8), so forgetting them is safe and lets the client retry the same key after, for example, a declined card. The cart state machine still blocks a second checkout under a new key, so the two mechanisms back each other up.

**Consequences:** Keys are kept forever and are global rather than per client. Both need changing for production (section 7).

## Decision: Coupons are reserved like stock

**Context:** A coupon must not be redeemed by two concurrent checkouts, and must not be consumed by a checkout that then fails.

**Options considered:**
- A: Validate at reserve time, mark as redeemed after payment. Two checkouts can both pass validation, and both redeem.
- B: Mark as redeemed at reserve time and undo it on failure. Readers (the report, other checkouts) would briefly see a "redeemed" coupon that later becomes available again.
- C: Add a `RESERVED` state between `AVAILABLE` and `REDEEMED`.

**Choice:** C.

**Why:** It reuses the reserve / commit / release path that already protects stock, and every state is truthful. The report can show `reserved` coupons and clients get a precise reason: `COUPON_IN_USE` (temporary, worth retrying) versus `COUPON_ALREADY_REDEEMED` (permanent).

**Consequences:** One more state to reason about. In a database the reservation needs an expiry, so a crashed instance cannot hold a coupon forever.

## Decision: Next milestone = (coupons issued + 1) × n

**Context:** A coupon may only be issued when a milestone is reached and has not already been rewarded, including when administrators call generate concurrently.

**Options considered:**
- A: Track a set of rewarded milestones and search for the first unrewarded one.
- B: Issue coupons automatically inside checkout when an order lands on a milestone.
- C: Issue oldest-first, never delete coupons, and derive the next milestone from the count.

**Choice:** C.

**Why:** "One coupon per milestone" becomes true by construction instead of something that has to be checked. Generation is synchronous, so concurrent requests cannot both see the same count. Option B would couple checkout to coupon issuing, which the brief assigns to an administrator.

**Consequences:** Deleting or voiding coupons would break the counting rule. If that feature were added, I would switch to an explicit unique milestone column (a unique constraint in a database).

## Decision: Charge the current price, with an optional expected total

**Context:** The brief asks what happens when price or availability changes after an item is added.

**Options considered:**
- A: Lock the price when the item is added. It can be gamed by keeping old carts, and stale prices need an expiry.
- B: Always charge the current price silently. Customers can be surprised.
- C: Charge the current price, and let the client state the total it showed the customer.

**Choice:** C.

**Why:** The server stays the source of truth for prices, but a client that showed the customer a total can make checkout fail instead of charging more (or less). The price is captured during the reserve step, so an admin price change while payment is pending cannot change what this checkout charges or records.

**Consequences:** Clients that do not send `expectedTotalCents` accept the current price. The cart view returns live prices so clients can show them.

## Decision: Integer cents, one rounding per order, rounded down

**Context:** No floating-point errors, deterministic discounts, and never a negative total.

**Options considered:** A decimal library; integer cents with round-half-up; integer cents with banker's rounding; per-line versus per-order discount.

**Choice:** Integer cents in plain numbers, validated as safe integers everywhere; `discount = floor(subtotal × x / 100)` applied once to the subtotal.

**Why:** Integers are exact and need no dependency. Rounding down means the store never gives away more than the advertised percentage. Because `x <= 100`, the discount cannot exceed the subtotal. Rounding once per order makes the result independent of how items are split into lines (two 5¢ items at 10% get 1¢ off, not 0¢ + 0¢).

**Consequences:** A single currency is assumed. Quantity (≤ 1000 per line) and price (≤ $1M) are capped, so totals stay far below `Number.MAX_SAFE_INTEGER`; the money functions also throw rather than lose precision if a limit is ever crossed.

## Decision: Report computed on every read

**Context:** The report must reconcile with orders and coupons, and repeated reads must not change state.

**Options considered:** Running counters updated during checkout, or deriving everything from stored orders and coupons on each request.

**Choice:** Derive on each request.

**Why:** Counters can drift from the data they summarise, for example when a code path forgets to update one. Deriving from the orders makes reconciliation automatic and the endpoint a pure read. At this scale it costs nothing.

**Consequences:** It is linear in the number of orders. In production it would be SQL aggregates, a read replica, or a materialised view (section 8).

## Decision: One error shape with stable codes

**Context:** Errors must be distinguishable and useful to an API client.

**Options considered:** Status codes only; free-text messages; RFC 9457 `application/problem+json`; a small custom envelope.

**Choice:** `{ "error": { "code", "message", "details" } }` with a closed `ErrorCode` union in `src/errors.ts`.

**Why:** Clients branch on a stable `code` and can use `details` (shortfalls, current total, existing order id) without parsing text. The union type means the full list of codes lives in one place and cannot drift from the README table. Problem+json would also work; the custom envelope is simpler to read for a small API.

**Consequences:** Status codes follow one rule: `400` the request is malformed or missing a required header; `402` payment declined; `404` the resource in the URL does not exist; `409` the request is valid but the current state forbids it; `422` the JSON is valid but its contents are not acceptable. That is why an unknown coupon is `422 COUPON_NOT_FOUND` and not `404`: the cart in the URL exists, the problem is in the body.

## 4. Transactions, concurrency and idempotency

**Atomicity.** The service runs in one Node.js process. JavaScript runs one synchronous block at a time, and other requests can only run at an `await`. So every state change is written as a synchronous block that validates first and mutates second. Checkout has exactly one `await` (the payment); coupon generation, cart edits, product updates and the report have none.

**Interleavings considered**, each with a test:

| While a checkout is waiting for payment… | Result |
|---|---|
| another checkout wants the same units | Sees them held → `409 INSUFFICIENT_INVENTORY` |
| another checkout wants the same coupon | Sees it `RESERVED` → `409 COUPON_IN_USE` |
| the same cart is checked out with a new key | `409 CHECKOUT_IN_PROGRESS` |
| the same request is repeated with the same key | Waits for the first, gets the same order |
| the cart is edited | `409 CART_NOT_OPEN` |
| an admin changes the price | The pending checkout keeps the price it reserved with |
| an admin cuts stock below the held units | `409 STOCK_BELOW_RESERVED` |
| the report is read | The pending order is not counted; its coupon shows as `reserved` |
| payment is declined | Stock and coupon released, cart reopened, `402` |

**Payment outcome.** The fake gateway either succeeds or clearly declines. A real provider can also time out with an unknown result. Releasing stock then could give away units that were actually paid for. The comment in `checkout()` marks this, and section 10 treats it as the first thing to fix.

**Testing overlap without flakiness.** Concurrency tests use a payment gateway that the test controls. It pauses a checkout mid-payment, sends competing requests at exactly that point, then approves or declines. Tests that only need volume (ten checkouts racing for three units) use the latency-based fake. I ran the suite repeatedly to check for flakiness.

## 5. Money and rounding

- All amounts are integers in cents; every helper checks it receives and returns safe non-negative integers and throws a `MoneyError` instead of rounding silently.
- `-0` (which `JSON.parse('-0')` produces) is stored as `0`.
- `lineTotal = unitPrice × quantity`; `subtotal = Σ lineTotal`.
- `discount = floor(subtotal × x / 100)`, once per order, with `x` an integer from 1 to 100; `total = subtotal − discount`. So `0 <= discount <= subtotal` and `total >= 0`.
- Examples: 999¢ at 10% → 99¢ off; 1¢ at 50% → 0¢; 4,999¢ + 12,999¢ at 10% → 1,799¢.
- The rounding is tested against exact `BigInt` arithmetic for every percent from 1 to 100 across all magnitudes, and with 2,000 random carts.

## 6. Error model

See the decision in section 3 and the full table in the README. Further choices:

- Request bodies are strict objects; an unknown or misspelled field is a `422`, not silently ignored.
- Codes say whether retrying makes sense: `COUPON_IN_USE` and `CHECKOUT_IN_PROGRESS` are temporary; `COUPON_ALREADY_REDEEMED` and `CART_ALREADY_CHECKED_OUT` are final.
- Unexpected errors return a generic `500 INTERNAL_ERROR` and are logged; internal details are not sent to the client.

## 7. Implemented versus deferred

**Implemented:** every required endpoint; a payment abstraction with a fake; stock and coupon reservation; idempotent checkout; milestone coupons; a reconciling report; extra admin endpoints (`GET /admin/orders`, `GET /admin/coupons`, `PATCH /admin/products/:id`) so reviewers can verify the report and provoke price or stock changes; strict validation; README, `requests.http`, and tests for concurrency, retries and failure paths.

**Deliberately deferred:**

- Persistence. State resets on restart.
- Authentication and admin roles.
- Expiry and per-client scoping of idempotency keys. Today they are global and kept forever, which grows memory without bound.
- Payments with an unknown outcome, refunds, and reconciliation.
- Expiry of reservations, needed once a process can crash mid-payment.
- Coupon expiry and per-customer coupons.
- Cart expiry and clean-up.
- Pagination of admin lists, rate limiting, structured logging and metrics, an OpenAPI document, graceful shutdown.

## 8. Multiple instances and production scale

The in-process guarantees hold only inside one process. With several instances, the guarantees would move into the database (PostgreSQL), and each in-memory step has a direct equivalent:

- **Hold stock:** in one transaction, for each line in product-id order (to avoid deadlocks): `UPDATE products SET reserved = reserved + $q WHERE id = $id AND stock - reserved >= $q`. If any update affects 0 rows, roll back and return the shortfall.
- **Lock the cart:** `UPDATE carts SET status = 'CHECKING_OUT' WHERE id = $id AND status = 'OPEN'`, checking the affected row count.
- **Hold the coupon:** `UPDATE coupons SET status = 'RESERVED', reserved_by = $cart, reserved_until = now() + interval '5 minutes' WHERE code = $code AND status = 'AVAILABLE'`.
- **One order per cart, one coupon per milestone:** unique constraints on `orders(cart_id)` and `coupons(milestone)`. Coupon generation becomes an insert that fails on conflict.
- **Idempotency:** insert the key row (`status = in_progress`, request fingerprint) before doing any work, with a unique constraint. A concurrent duplicate hits the constraint and gets `409` with `Retry-After`, or polls for the stored response. Keys expire after about 24 hours and are scoped per client.
- **Payment:** never inside an open database transaction. Reserve and commit are separate short transactions. Our idempotency key is passed to the provider so its side is idempotent too. A background job releases expired reservations and asks the provider about checkouts whose outcome is unknown.
- **Order numbers:** taken from a sequence inside the commit transaction.
- **Report:** SQL aggregates; at larger scale a read replica or periodically refreshed materialised view, accepting slight staleness.
- **Hot products:** a very popular product serialises on its row lock. If that became a bottleneck, options include splitting stock into several rows (buckets) or putting checkouts for that product through a queue.

## 9. How I used AI

I used **Claude (Claude Code, in VS Code)** throughout. It helped me read the brief and list invariants and open questions, propose the design above, and write the code, tests and documentation in small commits.

**How the output was verified:**
- Every commit ran the type checker and the full test suite.
- Concurrency tests were run 10–20 times in a row to check for flakiness.
- After each feature, I used **mutation testing**: deliberately breaking one rule at a time (rounding direction, stock reservation, cart lock, coupon reservation, idempotency fingerprint, milestone boundary, and more) and confirming that at least one test failed.
- The server was run for real and exercised with curl; the README examples come from those responses.

**Where I redirected the AI's output.** After the first money and pricing commit, I didn't accept the initial tests as enough and asked for every edge case to be run and checked. That pass found that `-0` passed validation unchanged, which is now fixed in `assertCents`. It also made mutation testing the standard check for every later commit. That later found a real gap: a test-suite blind spot where an off-by-one in the report's "coupon ready to generate" flag went unnoticed, because no test sat one order below a milestone. I added that test.

**Mistakes in AI output that were caught and fixed:**
- The first mutation script restored files with `git checkout`, which silently discarded the uncommitted `-0` fix. It was noticed when the test count changed, restored from a backup, and the script was rewritten to restore from in-memory copies and compare file contents afterwards.
- The first `tsconfig.json` used module options that TypeScript 7 removed.
- A draft coupon test expected a `409` from a checkout that would actually succeed, with a comment that didn't make sense. It was caught on review before running and replaced with a real failure case.
- The first test setup let supertest start a server per request, which produced listener-leak warnings. Tests now share one listening server per test app.

## 10. With two more hours

1. **Payments with an unknown outcome.** This is the most dangerous gap. On a timeout, keep the reservation instead of releasing it, mark the checkout as needing reconciliation, and resolve it by asking the provider (using our idempotency key). This is also where reservation expiry belongs.
2. **Bounded idempotency storage:** expiry (about 24 hours) and per-client scoping, with a test for an expired key.
3. **A repository interface with a SQLite or PostgreSQL implementation,** running the same concurrency tests against it to confirm the section 8 design rather than just describing it.
4. **A short load test** (for example with autocannon) on the scarce product, to check behaviour and latency under real contention.
