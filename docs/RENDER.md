# Free test deployment on Render (from a phone)

This puts a real, working copy of NorbsCoin online for testing, using Render's free plan.
No card, no computer and no command line are needed. Everything is set up by `render.yaml`.

## Steps

1. Go to **https://render.com** and tap **Get Started**. Sign up with **GitHub**, and allow Render
   to see the **NorbsCoin** repository.
2. In the Render dashboard tap **New → Blueprint**.
3. Choose the **NorbsCoin** repository. Render reads `render.yaml` and shows a database
   (`norbscoin-db`) and a web service (`norbscoin`).
4. Fill in the two boxes it asks for:
   - **BOOTSTRAP_OWNER_EMAIL**: your email (this is your operator login);
   - **BOOTSTRAP_OWNER_PASSWORD**: a password of at least 12 characters.
5. Tap **Deploy Blueprint** (or **Apply**). The first build takes about 5–10 minutes.
6. When the `norbscoin` service shows **Live**, open it. Its link looks like
   `https://norbscoin-xxxx.onrender.com`.

## First use

1. Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator,
   Authy or 1Password).
2. Open your link with **/admin** at the end and sign in with the email and password from step 4.
3. Copy the key shown, add it in the authenticator app ("Enter a setup key", time-based), and type
   the 6-digit code to finish.
4. In **Settings**:
   - enter test **payment instructions** (customers cannot order until you do);
   - if no exchange rate is shown, use **Set operator rate** (e.g. `0.1325`, valid 240 minutes);
   - add your support contacts.
5. Open your link (without /admin) in another tab or a private window and place a test order as a
   customer. Upload any photo as the receipt, then verify and pay it out in /admin.

## Good to know

- **Sleeping:** free services sleep after about 15 minutes without visitors. The next visit takes
  30–60 seconds to wake up. Background jobs (expiring unpaid orders, payout alerts) only run while
  it is awake.
- **30 days:** the free database expires 30 days after creation. For longer testing, move to a paid
  database or create a new blueprint.
- **Emails are not sent.** They are written to the service's **Logs** tab in Render. The customer
  still sees their private tracking link on screen after confirming.
- **Security:** after your first sign-in you can delete `BOOTSTRAP_OWNER_PASSWORD` in the service's
  **Environment** tab. It is only used when no operator account exists yet.
- **Updates:** Render redeploys automatically when changes are merged into `main`.
- **Do not use this free test deployment for real customers' money.** See `docs/OPERATIONS.md`.
