# Fee definition and economics

## The fee definition (decided)

**The 0.7% service fee is deducted from the gross converted amount.**

| Symbol | Meaning |
| --- | --- |
| A | Amount the customer sends, in RUB |
| R | GHS per 1 RUB used for the quote |
| G = A × R | Gross converted amount (GHS) |
| F = G × 0.007 | Service fee (GHS) |
| P = G − F | Amount the recipient receives (GHS) |

Example: A = 10,000 RUB, R = 0.1325 → G = 1,325.00 GHS, F = 9.28 GHS, P = 1,315.72 GHS.

Rounding: G and F are rounded half-up to 0.01 GHS; P is exact. This definition is the only one the
system supports. It is used in the converter, the quote and confirmation screens, the terms text, the
database and the CSV export, so the interface, terms and accounting always agree. Fee changes create a
new fee version; confirmed orders keep the fee they agreed to.

The fee is earned in GHS. The dashboard reports **collected** fees (completed orders only) separately
from **projected** fees (orders still in progress that may be rejected, cancelled or refunded).

## Stress test: 0.7% is not your profit

The fee is revenue on paper. What you actually keep per order is roughly:

```
margin ≈ fee (0.7%)
         − spread: how much worse the rate you can actually obtain is than the quoted rate
         − incoming cost: fees to receive RUB (bank / card / SBP charges)
         − payout cost: fees to send GHS (mobile money / bank transfer charges)
         − FX movement between quoting and actually converting
         − losses (fraud, mistaken payouts, disputes) and fixed operating costs per order
```

### Illustration (hypothetical numbers — replace with your real costs)

For an order with G = 1,000 GHS (fee = 7.00 GHS):

| Cost item (assumed) | GHS |
| --- | ---: |
| Service fee earned | +7.00 |
| Obtainable rate 0.4% worse than the reference rate quoted | −4.00 |
| Incoming RUB transfer cost 0.1% | −1.00 |
| Mobile money payout cost 0.5% | −5.00 |
| FX drift during the payout window, 0.2% average | −2.00 |
| **Margin** | **−5.00** |

With these assumptions every order **loses** money. The 0.7% fee is only viable if your real spread and
transfer costs are well below it.

### Levers the platform gives you

1. **Quote the rate you can actually obtain.** In *Settings → Exchange rate → Set operator rate*, enter the
   rate you can really buy GHS at, for a limited validity. It overrides the reference feed, is labelled
   "Operator-set rate" to customers, and caps quote expiry. Quoting at the obtainable rate removes the
   spread loss while staying transparent.
2. **Minimum order size.** Fixed per-order costs (a flat payout fee, your time) make small orders
   unprofitable. Raise `min_send_amount` until a minimum-size order covers them.
3. **Shorter windows.** Shorter quote TTLs and payment windows reduce FX exposure.
4. **Pause** the corridor whenever you cannot fulfil it at the quoted terms (liquidity, rate moves,
   bank holidays). Customers see your pause message instead of a quote.
5. **Fee changes** are a versioned setting — test a different fee without affecting confirmed orders.
6. **Disclosed extra fees.** The quote model and screens already carry an "other fees" line (currently
   always "None"). If you introduce a disclosed payout fee, it must be shown before confirmation.

### Revenue at volume (gross, not profit)

| Monthly volume (GHS) | Gross fees at 0.7% |
| ---: | ---: |
| 50,000 | 350 |
| 200,000 | 1,400 |
| 500,000 | 3,500 |
| 1,000,000 | 7,000 |

Subtract the cost items above (they scale with volume) plus fixed monthly costs (hosting, email
provider, compliance, your time). At a low percentage fee, reliable volume and low per-order cost
matter more than extra features. Use the dashboard's completed volume, average order size, payout
timing and rejection counts, and the CSV export, to track effective revenue against real costs.
