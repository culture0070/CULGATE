# CulGate usage guide

A complete, step-by-step guide to taking payments with CulGate. It assumes you can write
JavaScript and run a Node.js server, and nothing else: every term is explained, every step shows
code, and nothing is left for you to guess.

The examples are plain JavaScript. CulGate is written in TypeScript and ships full type
definitions, so the same code works in TypeScript with autocompletion and compile-time checks.

**If you are an AI assistant** generating code that uses CulGate, read
[Rules for generated code](#17-rules-for-generated-code) first. Those rules are not style advice;
breaking them produces code that loses money.

## Contents

1. [What CulGate is](#1-what-culgate-is)
2. [Words used in this guide](#2-words-used-in-this-guide)
3. [Requirements and installation](#3-requirements-and-installation)
4. [Get your provider keys](#4-get-your-provider-keys)
5. [Create the SDK](#5-create-the-sdk)
6. [How money is written](#6-how-money-is-written)
7. [Take a payment](#7-take-a-payment)
8. [Payment statuses](#8-payment-statuses)
9. [Hosted checkout (cards and more)](#9-hosted-checkout-cards-and-more)
10. [Webhooks: being told when a payment completes](#10-webhooks-being-told-when-a-payment-completes)
11. [Refunds](#11-refunds)
12. [Several accounts and switching providers](#12-several-accounts-and-switching-providers)
13. [Handling errors](#13-handling-errors)
14. [Testing without real credentials](#14-testing-without-real-credentials)
15. [Going live](#15-going-live)
16. [Common mistakes](#16-common-mistakes)
17. [Rules for generated code](#17-rules-for-generated-code)
18. [Quick reference](#18-quick-reference)

---

## 1. What CulGate is

CulGate is a library you add to your Node.js server. It gives you one set of functions for taking
payments, and translates them for the payment company you use (called a **provider**). Today it
supports **PayMongo** and **Xendit**.

```text
   your server code
          |
          |  sdk.payments.create({ account: 'main', ... })
          v
   +--------------+
   |   CulGate    |   picks the provider for that account, converts
   +--------------+   the request, converts the answer back
      |        |
      v        v
  PayMongo   Xendit      <- the companies that actually move the money
```

Three things to understand before writing any code:

1. **CulGate is a library, not a service.** There is no CulGate website to sign up for and no
   CulGate server. Your server talks directly to PayMongo or Xendit using your own keys.
2. **CulGate remembers nothing.** It has no database. Your application must store its own orders
   and the payment IDs CulGate returns.
3. **CulGate runs on your server only.** Never in a browser or a mobile app, because it needs your
   secret key.

## 2. Words used in this guide

| Word                      | Meaning                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider**              | The payment company: PayMongo or Xendit.                                                                                                |
| **Account**               | One set of keys at one provider, under a name you choose, such as `'main'`. You can configure several.                                  |
| **Secret key**            | The password your server uses to talk to the provider. Anyone who has it can act as you.                                                |
| **Test mode / live mode** | Providers give you two sets of keys. Test keys move no real money. Live keys do.                                                        |
| **Minor unit**            | The smallest unit of a currency. For Philippine pesos it is the centavo: PHP 1.00 = 100 centavos.                                       |
| **Payment**               | One attempt to collect money for a chosen payment method, such as GCash.                                                                |
| **Checkout session**      | A payment page hosted by the provider, where the customer picks a method (including cards) and pays.                                    |
| **Redirect**              | Sending the customer's browser to another website, here the provider's payment page.                                                    |
| **Return URL**            | The page on your site the provider sends the customer back to afterwards.                                                               |
| **Webhook**               | An HTTP request the provider sends to _your_ server to tell you something happened, such as "this payment was paid".                    |
| **Refund**                | Sending money back to the customer for a payment already made.                                                                          |
| **`async` / `await`**     | JavaScript's way of waiting for something slow, like a network call. Every CulGate function that talks to a provider must be `await`ed. |

## 3. Requirements and installation

**Requirements**

- Node.js version 22.12 or newer. Check with `node --version`.
- A PayMongo or Xendit account (free to create; test mode needs no business verification).

**Install**

Install the SDK and the provider you use:

```bash
npm install @culgate/sdk @culgate/provider-paymongo
```

```bash
npm install @culgate/sdk @culgate/provider-xendit
```

If you use Express or NestJS, also install the matching helper:

```bash
npm install @culgate/express
```

```bash
npm install @culgate/nestjs
```

> **Not on npm yet.** CulGate is pre-release and these packages are not published. Until they are,
> clone the repository, run `pnpm install && pnpm build`, and try the programs in
> [`examples/`](../../examples/), which work without any provider account.

**Importing**

CulGate packages are ES modules. Both styles of JavaScript work:

```js
// Modern style (file ends in .mjs, or package.json has "type": "module")
import { PaymentSDK } from '@culgate/sdk';
import { paymongo } from '@culgate/provider-paymongo';
```

```js
// Classic style (CommonJS, file ends in .js or .cjs)
const { PaymentSDK } = require('@culgate/sdk');
const { paymongo } = require('@culgate/provider-paymongo');
```

The rest of this guide uses the modern style. In classic style, the only other difference is that
`await` must be inside an `async function`.

## 4. Get your provider keys

**PayMongo:** sign in at dashboard.paymongo.com, open **Developers**, and copy the **secret key**
for test mode. It starts with `sk_test_`. The live key starts with `sk_live_`.

**Xendit:** sign in at dashboard.xendit.co, switch the dashboard to **Test mode**, open the
developer settings, and create a secret API key with write permission for money-in products.

Put keys in **environment variables**, never in your source code:

```bash
# .env  (add this file to .gitignore; never commit it)
PAYMONGO_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxx
PAYMONGO_WEBHOOK_SECRET=whsk_xxxxxxxxxxxxxxxx

XENDIT_SECRET_KEY=your-xendit-test-secret-key
XENDIT_ENVIRONMENT=test
XENDIT_WEBHOOK_TOKEN=xxxxxxxxxxxxxxxx
```

CulGate does not read `.env` files by itself. Load the file when you start Node.js:

```bash
node --env-file=.env server.mjs
```

The two webhook values come later, in [section 10](#10-webhooks-being-told-when-a-payment-completes).
You can leave them out until then.

| Variable                  | Required     | Meaning                                                                 |
| ------------------------- | ------------ | ----------------------------------------------------------------------- |
| `PAYMONGO_SECRET_KEY`     | Yes          | PayMongo secret key                                                     |
| `PAYMONGO_WEBHOOK_SECRET` | For webhooks | Signing secret of your PayMongo webhook (`whsk_...`)                    |
| `PAYMONGO_ENVIRONMENT`    | No           | `test` or `live`. Worked out from the key if you leave it out           |
| `XENDIT_SECRET_KEY`       | Yes          | Xendit secret key                                                       |
| `XENDIT_ENVIRONMENT`      | **Yes**      | `test` or `live`. Xendit keys do not reveal their mode, so you must say |
| `XENDIT_WEBHOOK_TOKEN`    | For webhooks | Xendit's webhook verification token                                     |

## 5. Create the SDK

Create **one** SDK object when your server starts, and reuse it everywhere. Put it in its own
file:

```js
// payments.mjs
import { PaymentSDK } from '@culgate/sdk';
import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';

export const sdk = new PaymentSDK({
  // 1. Which providers this server can use.
  providers: [paymongo()],

  // 2. Your accounts. The name on the left ('main') is yours to choose.
  accounts: {
    main: paymongoAccountFromEnv(), // reads PAYMONGO_SECRET_KEY and friends
  },
});
```

`paymongoAccountFromEnv()` reads the environment variables from section 4. If you would rather
pass values yourself (for example from a secrets manager), write the object out:

```js
accounts: {
  main: {
    provider: 'paymongo',
    secretKey: process.env.PAYMONGO_SECRET_KEY,
    webhookSecret: process.env.PAYMONGO_WEBHOOK_SECRET, // optional
    environment: 'test', // or 'live'
  },
},
```

For Xendit:

```js
import { xendit, xenditAccountFromEnv } from '@culgate/provider-xendit';

export const sdk = new PaymentSDK({
  providers: [xendit()],
  accounts: { main: xenditAccountFromEnv() },
});
```

**What happens if the configuration is wrong?** `new PaymentSDK(...)` throws immediately, with a
message naming the problem, for example:

```text
ConfigurationError: Environment variable "PAYMONGO_SECRET_KEY" is required but not set.
ConfigurationError: Account "main": "secretKey" does not match environment "live" (expected a key starting with "sk_live_").
```

That is deliberate: a server with broken payment configuration should fail at startup, not on a
customer's first purchase. Error messages name the setting but never print your key.

**Every call names its account.** Each function takes `account: 'main'` (or whatever you named
it). There is no default. This looks repetitive with one account, and prevents an expensive class
of mistakes the day you add a second.

## 6. How money is written

**Amounts are whole numbers in the smallest unit of the currency.** For pesos, that is centavos.

| You mean     | You write                            |
| ------------ | ------------------------------------ |
| PHP 1.00     | `{ value: 100, currency: 'PHP' }`    |
| PHP 150.00   | `{ value: 15000, currency: 'PHP' }`  |
| PHP 1,500.50 | `{ value: 150050, currency: 'PHP' }` |

Why not `1500.50`? Because computers cannot store most decimal fractions exactly. In JavaScript,
`0.1 + 0.2` is `0.30000000000000004`, and `0.29 * 100` is `28.999999999999996`. Errors like that
are unacceptable in money. Whole numbers of centavos are always exact.

CulGate **rejects** anything else. It never rounds for you:

```js
{ value: 1500.5, currency: 'PHP' }   // ValidationError: not a whole number
{ value: '150000', currency: 'PHP' } // ValidationError: a string, not a number
{ value: 150000, currency: 'php' }   // ValidationError: currency must be uppercase
```

**Converting from what a person typed.** Use the helpers; do not multiply by 100 yourself:

```js
import { fromDecimal, toDecimalString } from '@culgate/sdk';

fromDecimal('1500.50', 'PHP'); // { value: 150050, currency: 'PHP' }
fromDecimal('1500', 'PHP'); // { value: 150000, currency: 'PHP' }
fromDecimal('10.005', 'PHP'); // throws: too many decimal places for PHP

toDecimalString({ value: 150050, currency: 'PHP' }); // '1500.50'  (for display)
```

**Best practice:** store prices in your database as whole centavos too. Then nothing ever needs
converting, and adding up an order is ordinary whole-number arithmetic.

## 7. Take a payment

This section builds a complete GCash payment. The flow has four steps:

```text
 Customer            Your server                Provider (PayMongo / Xendit)
    |                     |                              |
    |  1. "Pay" click     |                              |
    |-------------------->|  sdk.payments.create(...)    |
    |                     |----------------------------->|
    |                     |   payment + checkoutUrl      |
    |                     |<-----------------------------|
    |  2. redirect to checkoutUrl                        |
    |<--------------------|                              |
    |------------------ customer approves in GCash ----->|
    |                                                    |
    |  3. sent back to your return URL                   |
    |<---------------------------------------------------|
    |-------------------->|  4. sdk.payments.retrieve()  |
    |                     |----------------------------->|
    |                     |      status: 'succeeded'     |
    |   "Thank you"       |<-----------------------------|
    |<--------------------|                              |
```

### Step 1: create the payment

```js
import { sdk } from './payments.mjs';

const payment = await sdk.payments.create({
  account: 'main', // which of your accounts
  amount: { value: 150000, currency: 'PHP' }, // PHP 1,500.00
  paymentMethod: { type: 'gcash' }, // how the customer pays
  reference: 'ORDER-1001', // YOUR order number
  description: 'Order 1001',
  returnUrls: {
    success: 'https://shop.example/orders/1001/return',
    cancel: 'https://shop.example/cart',
  },
});
```

What you get back:

```js
payment.id; // 'pi_abc123...'   the payment's ID. SAVE THIS.
payment.accountId; // 'main'
payment.provider; // 'paymongo'
payment.status; // 'requires_action'  (NOT paid yet)
payment.checkoutUrl; // 'https://...'    where to send the customer
payment.amount; // { value: 150000, currency: 'PHP' }
payment.reference; // 'ORDER-1001'
payment.providerStatus; // 'awaiting_next_action'  (PayMongo's own word)
payment.raw; // the provider's complete, untouched answer
```

**Save `payment.id` and the account name with your order, right now.** CulGate keeps no records.
If you lose the ID, you cannot ask about this payment later.

```js
await db.orders.update('1001', {
  paymentId: payment.id,
  paymentAccount: payment.accountId,
  status: 'awaiting_payment',
});
```

### Step 2: send the customer to the provider

```js
res.redirect(payment.checkoutUrl);
```

At this point **no money has moved**. The customer still has to approve the payment in GCash.

### Step 3: the customer comes back

The provider sends the customer's browser to your `success` return URL. This tells you only that
their browser arrived. **It does not prove they paid.** Anyone can type that URL.

### Step 4: ask the provider what really happened

```js
app.get('/orders/:id/return', async (req, res) => {
  const order = await db.orders.find(req.params.id);

  const payment = await sdk.payments.retrieve({
    account: order.paymentAccount,
    paymentId: order.paymentId,
  });

  if (payment.status === 'succeeded') {
    await db.orders.update(order.id, { status: 'paid' });
    res.send('Thank you! Your payment was received.');
  } else if (payment.status === 'requires_action' || payment.status === 'processing') {
    res.send('We are still waiting for your payment to be confirmed.');
  } else {
    res.send('The payment was not completed. Please try again.');
  }
});
```

### The whole thing, as an Express route

```js
import express from 'express';
import { sdk } from './payments.mjs';

const app = express();
app.use(express.json());

app.post('/orders/:id/pay', async (req, res, next) => {
  try {
    const order = await db.orders.find(req.params.id);

    const payment = await sdk.payments.create({
      account: 'main',
      amount: { value: order.totalCentavos, currency: 'PHP' },
      paymentMethod: { type: 'gcash' },
      reference: `ORDER-${order.id}`,
      returnUrls: {
        success: `https://shop.example/orders/${order.id}/return`,
        cancel: 'https://shop.example/cart',
      },
    });

    await db.orders.update(order.id, {
      paymentId: payment.id,
      paymentAccount: payment.accountId,
      status: 'awaiting_payment',
    });

    res.json({ redirectTo: payment.checkoutUrl });
  } catch (error) {
    next(error); // see section 13
  }
});
```

### Payment methods

`paymentMethod.type` chooses how the customer pays in `payments.create`:

| `type`      | PayMongo                        | Xendit                          |
| ----------- | ------------------------------- | ------------------------------- |
| `gcash`     | Yes                             | Yes                             |
| `shopeepay` | Yes                             | Yes                             |
| `maya`      | Yes                             | No                              |
| `grabpay`   | Yes                             | No                              |
| `billease`  | Yes                             | No                              |
| `card`      | Use hosted checkout (section 9) | Use hosted checkout (section 9) |

Asking for a method the account's provider cannot do throws `UnsupportedOperationError` before
anything is sent. To check first, see [section 12](#12-several-accounts-and-switching-providers).

### Waiting for the customer is not enough

Step 4 only runs if the customer returns to your site. Many do not: they pay in the GCash app and
close the browser. For those, the provider tells your server directly, with a **webhook**. A real
integration needs both. Webhooks are [section 10](#10-webhooks-being-told-when-a-payment-completes).

## 8. Payment statuses

`payment.status` is always one of these:

| Status            | Meaning                                                                    | Has the customer paid? |
| ----------------- | -------------------------------------------------------------------------- | ---------------------- |
| `pending`         | Created; nothing has happened yet, or an attempt failed and can be retried | No                     |
| `requires_action` | Waiting for the customer, usually to follow `checkoutUrl`                  | No                     |
| `processing`      | The provider is working on it                                              | No                     |
| `authorized`      | Money is reserved but not yet collected                                    | **No**                 |
| `succeeded`       | The provider confirmed the payment                                         | **Yes**                |
| `failed`          | This payment will not succeed                                              | No                     |
| `cancelled`       | Cancelled before it completed                                              | No                     |
| `expired`         | The customer ran out of time                                               | No                     |
| `unknown`         | The provider reported something CulGate does not recognize                 | Do not assume          |

**The only status that means "paid" is `succeeded`.** Write your code so that paid is the special
case and everything else is not paid:

```js
function describe(payment) {
  switch (payment.status) {
    case 'succeeded':
      return 'paid';
    case 'requires_action':
    case 'pending':
    case 'processing':
      return 'waiting';
    case 'failed':
    case 'cancelled':
    case 'expired':
      return 'not paid';
    default:
      // 'unknown', 'authorized', or a status added in a future version.
      // Never guess. Look at payment.providerStatus and decide by hand.
      return 'check manually';
  }
}
```

Always include the `default` branch. New statuses can be added in future versions, and a provider
can introduce a state CulGate has not seen; `payment.providerStatus` always holds the provider's
exact word.

## 9. Hosted checkout (cards and more)

With hosted checkout, the provider shows the customer a payment page with every method you allow,
**including cards**. Your server never sees a card number.

Use `sdk.checkout` when the customer should choose how to pay. Use `sdk.payments` (section 7) when
you already chose the method.

```js
const session = await sdk.checkout.create({
  account: 'main',
  lineItems: [
    // amount is the price of ONE unit, in centavos
    { name: 'T-shirt', quantity: 2, amount: { value: 50000, currency: 'PHP' } },
    { name: 'Shipping', quantity: 1, amount: { value: 15000, currency: 'PHP' } },
  ],
  reference: 'ORDER-1002',
  paymentMethods: ['card', 'gcash'], // optional; leave out for the provider's default
  returnUrls: {
    success: 'https://shop.example/orders/1002/thanks',
    cancel: 'https://shop.example/cart',
  },
});

session.id; // SAVE THIS with your order, like a payment ID
session.url; // send the customer here
session.amount; // { value: 115000, currency: 'PHP' }  (2 x 500.00 + 150.00, computed for you)
session.status; // 'open'

res.redirect(session.url);
```

**A checkout session is not a payment.** It is a page. A payment exists only after the customer
pays on it.

Find out what happened the same way as before: never trust the return URL, ask the provider.

```js
const session = await sdk.checkout.retrieve({ account: 'main', sessionId: order.sessionId });

if (session.status === 'completed') {
  // session.paymentId is the ID of the payment that was made.
  await db.orders.update(order.id, { status: 'paid', paymentId: session.paymentId });
}
```

| Session status | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| `open`         | The customer can still pay                                 |
| `completed`    | Paid. `session.paymentId` is set                           |
| `expired`      | No longer payable                                          |
| `cancelled`    | No longer payable (Xendit's word for a session you closed) |
| `unknown`      | Not recognized; do not assume                              |

**Closing a session.** If the customer abandons the order, or its price changes, close the old
session so the old link stops working:

```js
await sdk.checkout.expire({ account: 'main', sessionId: session.id });
```

This matters most on PayMongo, where **a session never expires by itself**: an old link stays
payable forever unless you close it. On Xendit, sessions expire after 30 minutes.

**One difference to know:** on Xendit the hosted page shows only the total and `description`, not
your individual line items. Put what the customer needs to recognize the order in `description`.

## 10. Webhooks: being told when a payment completes

A **webhook** is the provider calling _your_ server: "payment X was paid". You need webhooks
because customers do not always come back to your site after paying.

```text
 Provider                         Your server
    |   POST /webhooks/main            |
    |--------------------------------->|  1. is this really from the provider?  (verify)
    |                                  |  2. have I seen this event already?    (deduplicate)
    |                                  |  3. run your code                      (handle)
    |          200 OK                  |
    |<---------------------------------|
```

CulGate does steps 1 to 3 for you. You write the code for step 3.

### Step 1: tell the provider where to send webhooks

Your webhook address must be reachable from the internet over HTTPS, for example
`https://shop.example/webhooks/main`. (While developing on your own computer, use a tunnelling
tool to get a temporary public address.)

- **PayMongo:** in the dashboard under **Developers → Webhooks**, create a webhook with your URL
  and the events `payment.paid`, `payment.failed`, `payment.refund.updated`, and
  `checkout_session.payment.paid`. PayMongo then shows a **signing secret** starting with `whsk_`.
  Put it in `PAYMONGO_WEBHOOK_SECRET`.
- **Xendit:** in the dashboard's developer settings, open the webhook settings, set your URL for
  the Payments API events, and copy the **webhook verification token** into
  `XENDIT_WEBHOOK_TOKEN`.

Use **one URL per account**. If you have two accounts, create two URLs.

### Step 2: say what should happen

Register handlers once, when your server starts:

```js
// payments.mjs, below the `sdk` definition

sdk.webhooks.on('payment.succeeded', async (event) => {
  // Do not trust the event alone. Ask the provider for the current truth.
  const payment = await sdk.payments.retrieve({
    account: event.accountId,
    paymentId: event.resourceId,
  });

  if (payment.status === 'succeeded') {
    await markOrderPaid(payment.reference); // your own function
  }
});

sdk.webhooks.on('checkout.completed', async (event) => {
  const session = await sdk.checkout.retrieve({
    account: event.accountId,
    sessionId: event.resourceId,
  });
  if (session.status === 'completed') await markOrderPaid(session.reference);
});

sdk.webhooks.on('payment.failed', async (event) => {
  await markOrderFailed(event.resourceId);
});
```

Events you can listen for:

| Event                                                 | Meaning                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `payment.succeeded`                                   | A payment was paid                                                                               |
| `payment.failed`                                      | A payment failed                                                                                 |
| `payment.expired`                                     | A payment ran out of time (Xendit)                                                               |
| `checkout.completed`                                  | A checkout session was paid                                                                      |
| `checkout.expired`                                    | A checkout session expired (Xendit)                                                              |
| `refund.succeeded`, `refund.failed`, `refund.pending` | A refund changed                                                                                 |
| `provider.unknown`                                    | Anything CulGate does not recognize; `event.providerEventType` and `event.raw` hold the original |
| `'*'`                                                 | Every event                                                                                      |

### Step 3: add the route

With Express, it is one line per account:

```js
import express from 'express';
import { paymentWebhook } from '@culgate/express';
import { sdk } from './payments.mjs';

const app = express();

// IMPORTANT: webhook routes go BEFORE express.json().
app.post('/webhooks/main', paymentWebhook(sdk, { account: 'main' }));

app.use(express.json()); // for the rest of your routes
```

**Why before `express.json()`?** To prove a webhook is genuine, CulGate checks a signature
calculated over the _exact bytes_ the provider sent. `express.json()` replaces those bytes with a
parsed object, and the original cannot be rebuilt. If you get the order wrong, CulGate stops with
a clear `raw_body_unavailable` error rather than accepting an unverified request.

Without Express, call CulGate yourself with the raw body and the headers:

```js
import http from 'node:http';

http
  .createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/webhooks/main') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);

      const result = await sdk.webhooks.handle({
        account: 'main',
        rawBody: Buffer.concat(chunks), // the exact bytes; do NOT JSON.parse first
        headers: req.headers,
      });

      res.writeHead(result.response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.response.body));
    }
  })
  .listen(3000);
```

`handle` never throws for a fake request or a failing handler. It tells you what happened and
what to answer:

| `result.status` | Meaning                                                               | Answer sent      |
| --------------- | --------------------------------------------------------------------- | ---------------- |
| `processed`     | Genuine; your handlers ran                                            | 200              |
| `duplicate`     | Genuine, but already handled                                          | 200              |
| `rejected`      | Not genuine, or unreadable. Your handlers did **not** run             | 401, 400, or 413 |
| `failed`        | Genuine, but your handler threw an error. The provider will try again | 500              |

### Step 4: do not process the same event twice

Providers send a webhook again if your server was slow or down, so **the same event can arrive
more than once**. Without protection you might ship an order twice.

Give CulGate somewhere to record which events it has handled. It must be your database, so that it
survives restarts and is shared between servers. Create a table:

```sql
CREATE TABLE webhook_events (
  account_id  text        NOT NULL,
  provider    text        NOT NULL,
  event_id    text        NOT NULL,
  state       text        NOT NULL,              -- 'processing', 'completed', or 'failed'
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider, event_id)
);
```

Then write three small functions (this example uses PostgreSQL through the `pg` package):

```js
const eventStore = {
  // Returns true ONLY for the one caller that should process this event.
  async claim({ accountId, provider, eventId }) {
    const result = await pool.query(
      `INSERT INTO webhook_events (account_id, provider, event_id, state)
       VALUES ($1, $2, $3, 'processing')
       ON CONFLICT (account_id, provider, event_id) DO UPDATE
         SET state = 'processing', claimed_at = now()
         WHERE webhook_events.state = 'failed'
            OR (webhook_events.state = 'processing'
                AND webhook_events.claimed_at < now() - interval '5 minutes')
       RETURNING 1`,
      [accountId, provider, eventId],
    );
    return result.rowCount === 1;
  },

  async markCompleted({ accountId, provider, eventId }) {
    await pool.query(
      `UPDATE webhook_events SET state = 'completed'
       WHERE account_id = $1 AND provider = $2 AND event_id = $3`,
      [accountId, provider, eventId],
    );
  },

  async markFailed({ accountId, provider, eventId }) {
    await pool.query(
      `UPDATE webhook_events SET state = 'failed'
       WHERE account_id = $1 AND provider = $2 AND event_id = $3`,
      [accountId, provider, eventId],
    );
  },
};

export const sdk = new PaymentSDK({
  providers: [paymongo()],
  accounts: { main: paymongoAccountFromEnv() },
  webhooks: { eventStore },
});
```

The `claim` function must be **one single database statement**, as above. Do not write it as "look
up the event, then insert it": two webhooks arriving at the same instant would both find nothing
and both proceed. The `INSERT ... ON CONFLICT` lets the database guarantee only one wins.

The `WHERE` clause lets an event be taken again in two cases: your handler failed last time, or a
previous attempt started more than five minutes ago and never finished (the server probably
crashed).

For trying things out on your own computer only, there is a ready-made store that keeps events in
memory. It forgets everything on restart, so never use it in production:

```js
import { InMemoryWebhookEventStore } from '@culgate/sdk';
// webhooks: { eventStore: new InMemoryWebhookEventStore() }
```

### Three rules for webhook handlers

1. **Make them safe to run twice.** "Mark order paid" is safe to repeat. "Add 1 to the stock
   count" is not; guard it with a check on the order's current state.
2. **Ask the provider for the truth.** Events can arrive late or in the wrong order. Call
   `retrieve` and act on what it says now, as the examples above do.
3. **Be quick.** The provider waits for your answer. Record what needs doing and do slow work
   (emails, shipping labels) afterwards.

## 11. Refunds

You refund a payment using its payment ID.

```js
// Refund everything that has not been refunded yet
const refund = await sdk.refunds.create({
  account: 'main',
  paymentId: order.paymentId,
});

// Or refund part of it
const partial = await sdk.refunds.create({
  account: 'main',
  paymentId: order.paymentId,
  amount: { value: 50000, currency: 'PHP' }, // PHP 500.00
  reason: 'requested_by_customer',
});

refund.id; // SAVE THIS
refund.status; // usually 'pending' at first
refund.amount; // { value: ..., currency: 'PHP' }
```

For a checkout session, use the `paymentId` from the completed session:

```js
const session = await sdk.checkout.retrieve({ account: 'main', sessionId: order.sessionId });
await sdk.refunds.create({ account: 'main', paymentId: session.paymentId });
```

**A new refund is usually `pending`, not finished.** Do not tell the customer "refunded" yet.
Check later, or listen for the `refund.succeeded` webhook:

```js
const current = await sdk.refunds.retrieve({ account: 'main', refundId: refund.id });
if (current.status === 'succeeded') {
  // the provider has processed it
}
```

Even after `succeeded`, the money can take several days to reach the customer, depending on their
bank or e-wallet.

| `reason` you pass                                        | What happens                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `'duplicate'`, `'fraudulent'`, `'requested_by_customer'` | Sent to the provider as that reason                                  |
| Any other text, such as `'Wrong size'`                   | Sent as the provider's "other" reason, with your text kept as a note |
| Nothing                                                  | Sent as "other"                                                      |

**Never repeat a refund call just because it seemed to fail.** Neither provider protects you from
issuing the same refund twice. If a refund call times out, retrieve the payment's refunds from the
provider or its dashboard before trying again. A duplicate refund is real money gone.

## 12. Several accounts and switching providers

You can configure any number of accounts, on the same provider or different ones:

```js
import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';
import { xendit, xenditAccountFromEnv } from '@culgate/provider-xendit';

export const sdk = new PaymentSDK({
  providers: [paymongo(), xendit()],
  accounts: {
    'store-ph': paymongoAccountFromEnv(),
    // A second PayMongo account, read from PAYMONGO_WHOLESALE_SECRET_KEY etc.
    'wholesale-ph': paymongoAccountFromEnv({ prefix: 'PAYMONGO_WHOLESALE' }),
    'store-xendit': xenditAccountFromEnv(),
  },
});
```

To send a payment through a different provider, change the account name. Nothing else:

```js
async function pay(order, account) {
  return sdk.payments.create({
    account, // 'store-ph' goes to PayMongo, 'store-xendit' goes to Xendit
    amount: { value: order.totalCentavos, currency: 'PHP' },
    paymentMethod: { type: 'gcash' },
    reference: `ORDER-${order.id}`,
    returnUrls: { success: `https://shop.example/orders/${order.id}/return` },
  });
}
```

**Providers are not identical**, and CulGate does not pretend they are. Ask what an account can do
before offering it to a customer:

```js
sdk.capabilities.supports({
  account: 'store-xendit',
  operation: 'payments.create',
  currency: 'PHP',
  paymentMethod: 'maya',
}); // false: Xendit direct payments do not include Maya

// With the reason, for logging:
sdk.capabilities.check({ account: 'store-xendit', operation: 'payments.capture' });
// { supported: false, reason: 'operation "payments.capture" is not available' }

// Everything an account can do:
sdk.capabilities.operations('store-ph');
// ['payments.create', 'payments.retrieve', 'payments.cancel', 'refunds.create', ...]
```

A practical use: show only the buttons that will work.

```js
const methods = ['gcash', 'maya', 'grabpay', 'shopeepay'].filter((paymentMethod) =>
  sdk.capabilities.supports({ account, operation: 'payments.create', paymentMethod }),
);
```

**Always store the account name with each payment.** A payment ID from one account means nothing
to another, even on the same provider. Asking the wrong account gives `PaymentNotFoundError`.

**Something a provider offers that CulGate does not cover?** You can call the provider's own API
with the account's key applied for you. This is provider-specific code and will not work on
another provider:

```js
const client = sdk.accounts.getClient('store-ph');
const response = await client.providerRequest({
  method: 'GET',
  path: '/v1/payments',
  query: { limit: 5 },
});
response.status; // 200
response.body; // PayMongo's own JSON, untouched
```

## 13. Handling errors

Every CulGate function that can fail throws an error object. Wrap calls in `try` / `catch`:

```js
import {
  AuthenticationError,
  NetworkError,
  PaymentSDKError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  UnsupportedOperationError,
  ValidationError,
} from '@culgate/sdk';

async function createPaymentSafely(input) {
  try {
    return { ok: true, payment: await sdk.payments.create(input) };
  } catch (error) {
    if (error instanceof ValidationError) {
      // Your input was wrong. Nothing was sent. error.issues lists each problem.
      return { ok: false, kind: 'bad-input', issues: error.issues };
    }
    if (error instanceof UnsupportedOperationError) {
      // This account's provider cannot do this. Nothing was sent.
      return { ok: false, kind: 'unsupported', reason: error.reason };
    }
    if (error instanceof TimeoutError || error instanceof NetworkError) {
      // DANGER: we do not know whether the payment was created. See below.
      return { ok: false, kind: 'unknown-outcome' };
    }
    if (error instanceof RateLimitError) {
      // Too many requests. Wait error.retryAfterMs milliseconds if it is set.
      return { ok: false, kind: 'slow-down', waitMs: error.retryAfterMs };
    }
    if (error instanceof AuthenticationError) {
      // Your key is wrong or was revoked. Alert yourself; customers cannot fix this.
      return { ok: false, kind: 'bad-credentials' };
    }
    if (error instanceof ProviderError) {
      // The provider said no. error.providerCode is the provider's own reason code.
      return { ok: false, kind: 'provider', code: error.providerCode, requestId: error.requestId };
    }
    if (error instanceof PaymentSDKError) {
      return { ok: false, kind: error.code };
    }
    throw error; // not a CulGate error: a bug somewhere else
  }
}
```

The order of the checks matters: `TimeoutError` is a kind of `NetworkError`, and
`AuthenticationError` and `RateLimitError` are kinds of `ProviderError`, so test the specific ones
first, as above.

| Error                          | When it happens                                     | Was anything sent? |
| ------------------------------ | --------------------------------------------------- | ------------------ |
| `ConfigurationError`           | Wrong setup, or an account name that does not exist | No                 |
| `ValidationError`              | Bad input, such as a decimal amount                 | No                 |
| `UnsupportedOperationError`    | The provider cannot do this                         | No                 |
| `AuthenticationError`          | The provider rejected your key                      | Yes; refused       |
| `RateLimitError`               | Too many requests                                   | Yes; refused       |
| `PaymentNotFoundError`         | No such payment on that account                     | Yes                |
| `RefundError`                  | The provider refused a refund, or cannot find it    | Yes                |
| `ProviderError`                | Any other refusal from the provider                 | Yes                |
| `TimeoutError`, `NetworkError` | No answer arrived                                   | **Unknown**        |

Useful fields on every error:

```js
error.name; // 'ProviderError'
error.code; // 'provider_error'   stable; safe to test in code
error.message; // a description for developers
error.accountId; // 'main'
error.provider; // 'paymongo'
error.providerCode; // 'parameter_below_minimum'   the provider's own code
error.httpStatus; // 400
error.requestId; // quote this to the provider's support team
```

**Test `error.code` and `error.providerCode`, never the text of `error.message`.** Messages are
written for developers and may change. Do not show them to customers. For logging,
`JSON.stringify(error)` gives a safe summary with no key in it.

### The dangerous case: no answer

A `TimeoutError` or `NetworkError` while creating a payment or refund means **you do not know**
whether it happened. The request may have arrived and the answer got lost.

**Do not simply try again.** You could create two payments, or refund twice.

1. Save the order as "payment status unknown".
2. Look for the payment by your `reference` in the provider's dashboard, or wait for the webhook.
3. Create a new payment only once you are sure the first one does not exist, or after cancelling
   it.

CulGate itself never repeats a create or refund request, for the same reason. It does repeat
reads (`retrieve`), which are harmless to repeat.

## 14. Testing without real credentials

CulGate includes a **mock provider**: a pretend payment company that runs inside your program,
needs no keys and no internet, and moves no money. Use it in your automated tests.

```js
import assert from 'node:assert/strict';
import { PaymentSDK } from '@culgate/sdk';
import { mockProvider } from '@culgate/core/testing';

const mock = mockProvider();
const sdk = new PaymentSDK({
  providers: [mock],
  accounts: {
    main: {
      provider: 'mock',
      secretKey: 'anything',
      webhookSecret: 'anything-else', // only needed to test webhooks
      environment: 'test',
    },
  },
});

// 1. Create a payment, exactly as with a real provider.
const payment = await sdk.payments.create({
  account: 'main',
  amount: { value: 150000, currency: 'PHP' },
  reference: 'ORDER-1001',
});
assert.equal(payment.status, 'pending');

// 2. Pretend the customer paid.
mock.setPaymentStatus('main', payment.id, 'succeeded');

// 3. Pretend the provider sent a webhook, correctly signed.
const webhook = mock.signWebhook('main', {
  id: 'evt_1',
  type: 'mock.payment.succeeded',
  resourceId: payment.id,
});
const result = await sdk.webhooks.handle({
  account: 'main',
  rawBody: webhook.rawBody,
  headers: webhook.headers,
});
assert.equal(result.status, 'processed');

// 4. Pretend the customer paid on a hosted checkout page.
const session = await sdk.checkout.create({
  account: 'main',
  lineItems: [{ name: 'T-shirt', quantity: 1, amount: { value: 50000, currency: 'PHP' } }],
});
const paymentId = mock.completeCheckout('main', session.id);

// 5. Check what your code asked the provider to do.
mock.calls; // [{ accountId: 'main', operation: 'payments.create', input: {...} }, ...]
```

To test your code against a provider that cannot do something, restrict the mock:

```js
const limited = mockProvider({
  operations: ['payments.create', 'payments.retrieve'], // no refunds
  currencies: ['PHP'],
  paymentMethods: ['gcash'],
});
```

Because your application code only talks to `sdk`, the same code runs against the mock in tests
and against PayMongo or Xendit in production. Only the `providers` and `accounts` setup differs.

**The mock is for tests only.** Never register `mockProvider()` in a production server: it
accepts every payment and collects no money.

After your automated tests, try the real provider in **test mode** with test keys. In PayMongo's
test mode, the GCash page shows "Authorize Test Payment" and "Expire/Fail Test Payment" buttons instead
of asking for a real GCash account.

## 15. Going live

Work through this list before accepting real money.

1. **Finish and test everything in test mode first**, including a refund and a webhook.
2. **Switch to live keys.** Put the live key in your production environment variables. For Xendit,
   also set `XENDIT_ENVIRONMENT=live`.
3. **Create the live webhook.** Test and live webhooks are separate, with separate secrets. Create
   one in live mode pointing at your production URL, and set its secret in production.
4. **Use a real event store.** Your database, as in section 10. Not the in-memory one.
5. **Confirm your server is on HTTPS** and the webhook URL is reachable from the internet.
6. **Check your logs contain no secrets.** Do not log `payment.raw` or `event.raw` in full; they
   can contain customer details.
7. **Reconcile regularly.** Once a day, list your orders still marked "awaiting payment" and call
   `sdk.payments.retrieve` on each. This catches anything a missed webhook left behind.
8. **Make one small real payment yourself**, then refund it.

## 16. Common mistakes

| Mistake                                                        | What goes wrong                                 | Do this instead                        |
| -------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| Writing `1500.50` as the amount                                | `ValidationError`                               | Whole centavos: `150050`               |
| Multiplying by 100 yourself                                    | `19.99 * 100` is `1998.9999999999998`           | `fromDecimal('19.99', 'PHP')`          |
| Treating `requires_action` or `pending` as paid                | Goods shipped for free                          | Only `succeeded` is paid               |
| Marking an order paid when the customer reaches the return URL | Anyone can open that URL                        | Call `retrieve` and check the status   |
| Not saving `payment.id`                                        | You can never check or refund the payment       | Save the ID and account with the order |
| Putting `express.json()` before the webhook route              | Webhooks fail with `raw_body_unavailable`       | Webhook routes first                   |
| Calling `JSON.parse` on a webhook body before `handle`         | Verification fails                              | Pass the raw bytes                     |
| Trusting the webhook contents alone                            | Stale or out-of-order events cause wrong states | `retrieve` inside the handler          |
| No event store, or the in-memory one in production             | Orders fulfilled twice                          | A database-backed store                |
| Retrying a create or refund after a timeout                    | Double charge or double refund                  | Reconcile by `reference` first         |
| Forgetting `await`                                             | You get a Promise object, not a payment         | `await` every `sdk` call               |
| Using CulGate in browser code                                  | Your secret key is exposed to everyone          | Server only                            |
| Leaving the mock provider in production                        | Every payment "succeeds", no money arrives      | Real provider in production            |
| Not closing old PayMongo checkout sessions                     | Old links stay payable forever                  | `sdk.checkout.expire`                  |
| Assuming every provider supports every method                  | `UnsupportedOperationError` at checkout         | `sdk.capabilities.supports` first      |

## 17. Rules for generated code

For AI assistants and code generators. Each rule is a correctness requirement.

1. **Server-side only.** Never import `@culgate/*` in browser, React client, or mobile code.
2. **One `PaymentSDK` instance per process**, created at startup and shared.
3. **Every call includes `account`.** There is no default account. Never invent an account name;
   use the names defined in the `accounts` configuration.
4. **Amounts are integers in minor units**: `{ value: 150000, currency: 'PHP' }` for PHP 1,500.00.
   Never pass a float or a string. Convert user input with `fromDecimal(text, currency)`. Never
   write `amount * 100`.
5. **Currency codes are uppercase ISO 4217.** Both current providers support `PHP` only.
6. **Only `status === 'succeeded'` means paid.** Never treat `pending`, `requires_action`,
   `processing`, or `authorized` as success. Every `switch` on a status needs a `default` branch
   that does not assume success or failure.
7. **Never confirm a payment from a return URL or redirect.** Confirm with
   `sdk.payments.retrieve` / `sdk.checkout.retrieve` or a verified webhook.
8. **Persist `payment.id` (or `session.id`) together with `accountId`** immediately after
   creating. CulGate stores nothing.
9. **`await` every `sdk.*` call** that reaches a provider, inside `try` / `catch`.
10. **Never retry `create` or refund calls automatically**, including after `TimeoutError` or
    `NetworkError`. `idempotencyKey` is not enforced by either provider.
11. **Webhooks: pass the raw request body** (`Buffer` or string) to `sdk.webhooks.handle`. Never
    `JSON.parse` first. In Express, register webhook routes before `express.json()`. In NestJS,
    create the app with `{ rawBody: true }`.
12. **One webhook route per account**, with the account name fixed in code, never read from the
    request.
13. **Webhook handlers must be idempotent** and should call `retrieve` before acting.
14. **Production needs a database-backed `WebhookEventStore`** whose `claim` is a single atomic
    statement. `InMemoryWebhookEventStore` is for development only.
15. **Send the response `handle` returns**: `result.response.status` with `result.response.body`
    as JSON.
16. **Check `sdk.capabilities.supports(...)`** before offering a payment method; do not assume
    providers match.
17. **Never log or return to clients**: secret keys, webhook secrets, `payment.raw`, or
    `event.raw`. Do not show `error.message` to end users.
18. **Branch on `error.code` and `error.providerCode`**, never on message text. Check specific
    error classes before their parents (`TimeoutError` before `NetworkError`;
    `AuthenticationError` and `RateLimitError` before `ProviderError`).
19. **`mockProvider()` from `@culgate/core/testing` is for tests only.**
20. **Do not invent API.** The complete surface is in [section 18](#18-quick-reference). If a
    function is not listed there, it does not exist.

## 18. Quick reference

**Setup**

```js
import { PaymentSDK } from '@culgate/sdk';
import { paymongo, paymongoAccountFromEnv } from '@culgate/provider-paymongo';
import { xendit, xenditAccountFromEnv } from '@culgate/provider-xendit';

const sdk = new PaymentSDK({
  providers: [paymongo(), xendit()],
  accounts: { main: paymongoAccountFromEnv(), other: xenditAccountFromEnv() },
  webhooks: { eventStore }, // optional
  logger: { debug, warn }, // optional; receives no secrets
});
```

**Every function** (`→` shows what the promise resolves to)

```js
// Payments
sdk.payments.create({ account, amount, paymentMethod?, reference?, description?,
                      returnUrls?, metadata?, idempotencyKey? })          // → Payment
sdk.payments.retrieve({ account, paymentId })                             // → Payment
sdk.payments.cancel({ account, paymentId })                               // → Payment
sdk.payments.capture({ account, paymentId, amount? })                     // → Payment (no current provider supports it)

// Hosted checkout
sdk.checkout.create({ account, lineItems, reference?, description?, paymentMethods?,
                      returnUrls?, metadata?, idempotencyKey? })          // → CheckoutSession
sdk.checkout.retrieve({ account, sessionId })                             // → CheckoutSession
sdk.checkout.expire({ account, sessionId })                               // → CheckoutSession

// Refunds
sdk.refunds.create({ account, paymentId, amount?, reason?, idempotencyKey? }) // → Refund
sdk.refunds.retrieve({ account, refundId })                               // → Refund

// Webhooks
sdk.webhooks.on(eventType, handler)                                       // returns an "unsubscribe" function
sdk.webhooks.handle({ account, rawBody, headers })                        // → { status, response, event?, error? }
sdk.webhooks.verify({ account, rawBody, headers })                        // → nothing; throws if not genuine
sdk.webhooks.parse({ account, rawBody, headers })                         // → event; verifies first

// What an account can do (these do not contact the provider, so no await)
sdk.capabilities.supports({ account, operation, currency?, paymentMethod? }) // true or false
sdk.capabilities.check({ account, operation, currency?, paymentMethod? })    // { supported, reason? }
sdk.capabilities.operations(account)                                         // list of operation names

// Accounts (no await)
sdk.accounts.list()                 // [{ id, provider, environment }]
sdk.accounts.get(accountId)         // { id, provider, environment }
sdk.accounts.has(accountId)         // true or false
sdk.accounts.getClient(accountId)   // provider-specific client; .providerRequest({ method, path, query?, body?, headers? })

// Money
fromDecimal('1500.50', 'PHP')                          // { value: 150050, currency: 'PHP' }
toDecimalString({ value: 150050, currency: 'PHP' })    // '1500.50'
```

**Shapes**

```js
// Money
{ value: 150000, currency: 'PHP' }

// Payment
{ id, accountId, provider, providerPaymentId, amount, status, providerStatus,
  reference?, paymentMethod?: { type, providerType }, checkoutUrl?, metadata?,
  createdAt?, updatedAt?, raw }

// CheckoutSession
{ id, accountId, provider, providerSessionId, url?, status, providerStatus?,
  amount?, reference?, paymentId?, metadata?, createdAt?, expiresAt?, raw }

// Refund
{ id, accountId, provider, providerRefundId, paymentId, amount, status,
  providerStatus, reason?, createdAt?, raw }

// Webhook event
{ id?, accountId, provider, type, resourceId?, occurredAt?, data,
  providerEventType, raw }

// Line item (checkout)
{ name, quantity, amount, description? }   // amount = price of one unit
```

**Values**

| What                     | Possible values                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment status           | `pending`, `requires_action`, `processing`, `authorized`, `succeeded`, `failed`, `cancelled`, `expired`, `partially_refunded`, `refunded`, `unknown`                                                                                                                   |
| Checkout status          | `open`, `completed`, `expired`, `cancelled`, `unknown`                                                                                                                                                                                                                 |
| Refund status            | `pending`, `processing`, `succeeded`, `failed`, `cancelled`, `unknown`                                                                                                                                                                                                 |
| Webhook event type       | `payment.pending`, `payment.requires_action`, `payment.processing`, `payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.expired`, `refund.pending`, `refund.succeeded`, `refund.failed`, `checkout.completed`, `checkout.expired`, `provider.unknown` |
| Operation                | `payments.create`, `payments.retrieve`, `payments.cancel`, `payments.capture`, `refunds.create`, `refunds.retrieve`, `checkout.create`, `checkout.retrieve`, `checkout.expire`, `webhooks.verify`, `webhooks.normalize`, `provider.request`                            |
| Direct payment methods   | PayMongo: `gcash`, `maya`, `grabpay`, `shopeepay`, `billease`. Xendit: `gcash`, `shopeepay`                                                                                                                                                                            |
| Checkout payment methods | PayMongo: `card`, `gcash`, `maya`, `grabpay`, `shopeepay`, `billease`, `qrph`. Xendit: `card`, `gcash`, `maya`, `grabpay`, `shopeepay`, `qrph`                                                                                                                         |
| Error classes            | `ConfigurationError`, `ValidationError`, `UnsupportedOperationError`, `ProviderError`, `AuthenticationError`, `RateLimitError`, `PaymentNotFoundError`, `RefundError`, `NetworkError`, `TimeoutError`, `WebhookVerificationError` (all extend `PaymentSDKError`)       |

**Where to go next**

- Runnable programs: [`examples/`](../../examples/)
- Provider details and differences: [compatibility matrix](../providers/compatibility.md),
  [PayMongo](../providers/paymongo.md), [Xendit](../providers/xendit.md)
- Deeper guides: [webhooks](webhooks.md), [checkout](checkout.md), [refunds](refunds.md),
  [errors and retries](errors-and-retries.md), [idempotency](idempotency.md),
  [configuration](configuration.md), [Express](express.md), [NestJS](nestjs.md)
- Every export: [API reference](../api/README.md)
