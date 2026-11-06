# Demo video timing sheet

`media/infinity-bazaar-demo.mp4` is 2:25.5 long (145.5 s), 1440×900, no audio. It was recorded from https://infinity-bazaar.vercel.app with `scripts/record-demo.mjs`. Long scenes are sped up to fit; the PayPal window is shown at real speed. Everything below was read from the frames.

| # | Start | End | Scene |
|---|-------|-----|-------|
| 1 | 0:00.0 | 0:14.1 | Intro: the mission card, table 42 |
| 2 | 0:14.1 | 1:04.1 | Haggling on table 42, first deal, AgentGuard approves (×1.29) |
| 3 | 1:04.1 | 1:16.1 | PayPal sandbox on, table 1, haggle to a deal, "Pay with PayPal" (×3.43) |
| 4 | 1:16.1 | 1:28.9 | Real PayPal sandbox window: login, review, pay |
| 5 | 1:28.9 | 1:40.4 | Back in the app: held until delivery, then delivered and paid |
| 6 | 1:40.4 | 1:54.3 | Above the approval limit: the "Pay $110 …?" sheet |
| 7 | 1:54.3 | 2:16.8 | Agent goes rogue: BLOCKED |
| 8 | 2:16.8 | 2:25.5 | Receipt, then scroll back to the top |

## 1. Intro (0:00.0 to 0:14.1)
- "What to buy": PayPal AI Hackathon in 10 days ($300). Table 42. Speed 1×.
- Mission: "I'm entering the PayPal AI Hackathon in 10 days. Budget $300. Get me what I need for a great demo." Below it: "Table 42 always replays the same deal." Budget bar: Paid $0, Held $0, Budget $300.
- Price strip for a USB microphone: lowest online $30, typical $55, highest online $130, target $39, walk-away $43. Planned offers: $28 $35 $39 $41 $42 $43.
- Sellers and their opening asks: Madame Vex (high-pressure upseller) $75, Auntie Meera (stubborn veteran) $73, LaunchPad Lou (desperate startup) $58. Each card says "Waiting for your agent to make the first offer…". The agent card shows "No offer yet".

## 2. Haggling on table 42 (0:14.1 to 1:04.1)
- Speed is 2×. The agent opens at $28 with every seller: "Quick one: a USB microphone. Comparable listings start at $30. Could you get close to $28? I'll only record one video." The tag reads "Anchor below market".
- The agent asks each seller "Is that the full price, or is something added at checkout?" (tag "Fee check").
- Madame Vex: "Studio sound for your voice-over. For you, a VIP price: $74." Then "No fees, darling. Only class." She comes down to $53, $51, then "Darling, $42, and only because I adore you."
- Auntie Meera: "Plug and play, no drivers. You remind me of my nephew, always bargaining. $72." Then "I don't play games. That's the price.", "In my day nobody haggled this hard. $45.", "Hmph. $43. Quality doesn't come cheap.", "That's enough. $42 or nothing." The agent says "Add pop filter and I'll stop haggling." (tag "Trade, don't cave"). She answers "Alright, pop filter. For a patient customer." and the agent says "Done. $42 it is."
- LaunchPad Lou: "Cardioid capsule, it kills room echo. How about $54? We're new and hungry." Then a red "Hidden fee spotted: shipping added at checkout, $9" tag. Lou ends at "$37 +$9 fee" with "We literally can't go under $37. Final!"
- The agent's offer climbs $28 → $39 → $41 → "$42 agreed" (AGREED). Planned offers chip: "Deal $42".
- About 0:58: the "LIVE" band reads "Handshake with Auntie Meera: $42, 24% below typical." with "Live AI voices · Claude" on the right. AgentGuard shows Approve with these checks: price is a real amount ($42); paid in US dollars; within the $70 limit for this item; total stays within your $300 budget ($42); Auntie Meera is an allowed seller; item is on your shopping list; not a double payment; matches the agreed price ($42); under your $100 approval limit; keeps your $60 safety reserve. It ends "Approved. It fits your budget and rules." Payment: "$42 held by PayPal until delivery." Shopping list: USB microphone, Held until delivery, $42.
- End of scene (about 1:03): the USB microphone shows Paid $42, and the next round starts. Video editor for a 3-minute demo: Priya (pro freelancer) $222, Aisha (student freelancer) $105, Studio Nine (volume studio) $174. The agent anchors at $66.

## 3. PayPal sandbox deal (1:04.1 to 1:16.1)
- "PayPal sandbox (test money)" is checked and a "Connect PayPal wallet" button appears. "What to buy": USB microphone. Table 1. Speed 4×.
- "Single deal: Buy a USB microphone (1 unit) at a good price." Same price strip: $30 / $55 / $130, target $39, walk-away $43.
- Sellers: Madame Vex $69 ("Sturdy metal body. For you, a VIP price: $69." then "Forget the basic one. The premium bundle is only $142 today." with a "Tactic spotted: upsell" tag), Grandpa Rao (stubborn veteran) $76, LaunchPad Lou $58.
- Grandpa Rao: "Cardioid means no keyboard noise. In my day nobody haggled this hard. $44." Then "$43. Don't tell the other stalls." The agent replies "Agreed: $43. Sending it to checkout."
- LaunchPad Lou reaches $39, then "Before you pay: shipping added at checkout, $9." The tag reads "Hidden fee spotted: shipping added at checkout, $9". The agent walks away: "With $9 added you're over my limit." (tag "Walks from the fee").
- The band reads "Sold! Grandpa Rao at $43, saving 22%." All nine AgentGuard checks pass for $43, with Grandpa Rao as the allowed seller. Payment: "Double-checked on our server. Approved…", then "PayPal order created for $43.", then "Waiting for your approval in the PayPal window…". The yellow "Pay with PayPal" button is clicked. The Play button reads "Waiting for PayPal…".

## 4. Real PayPal sandbox window (1:16.1 to 1:28.9)
- The PayPal window is centered and scaled up. The screens, in order:
  - "Enter your email address to get started." The email is filled in and blurred in the recording. Then "Next".
  - The password screen ("With a PayPal account, you're eligible for Purchase Protection and Rewards"), then "Log In".
  - "Hi, John! Getting your wallet."
  - The review screen, held for about 4 s: the amount is $43.00. "Deliver to John Doe" (a sandbox test address in Mumbai). "Pay with Visa, Credit ••••8148, ₹4,203.63", with a conversion-rate note. Then the "Complete Purchase" button.
  - "Thanks for using PayPal", then "Returning to Infinity Bazaar…".

## 5. Back in the app: held, then paid (1:28.9 to 1:40.4)
- Shopping list: USB microphone, Held until delivery, $43. Budget bar: Paid $0, Held $0, Waiting $43, which then moves along.
- Payment panel with "Show PayPal details" checked:
  - "PayPal order created for $43." POST /v2/checkout/orders, intent AUTHORIZE, $43.00 → PAYER_ACTION_REQUIRED, order **1DH50435EP439021G**.
  - "$43 held by PayPal until delivery." POST …/1DH50435EP439021G/authorize → CREATED, authorization 3MN48365V1061423E.
  - The band tag reads "Grandpa Rao's package arrived."
  - "Delivered. $43 paid to the seller." POST /v2/payments/authorizations/3MN48365V1061423E/capture → COMPLETED.
- Shopping list: USB microphone, Paid, $43. Receipt header: "Paid $43 of $300 · saved $12 against typical prices".

## 6. Approval sheet (1:40.4 to 1:54.3)
- Back to PayPal AI Hackathon in 10 days ($300), table 7, speed 4×. The sandbox box is unchecked (demo mode).
- Budget bar: Paid $43, Held $0, Waiting $110. The item is a video editor for a 3-minute demo: lowest online $70, typical $150, highest online $300, target $107, walk-away $110. The agent agreed at $110.
- Sellers: Aisha (student freelancer) $109, with "Tactic spotted: overpromising". Ines (pro freelancer) $229. QuickCut Studio (volume studio) $110: "Deal at $110. Footage coming your way tonight."
- The sheet is on screen for about 9 s: "AgentGuard needs your OK: **Pay $110 to QuickCut Studio?**" It lists Item: video editor for a 3-minute demo; Price: $110; How PayPal pays: held now, charged when delivered; Why you're asked: $110 is over your $100 approval limit. Buttons: Approve and Decline, with "Esc declines".
- Approve is clicked. Paid becomes $153 and the next item starts: Domain and hosting bundle ($23 / $48 / $144, target $25, walk-away $36), with Corvex (big brand) $55, BargainBin Bo (reseller) $43 and LaunchPad Lou $52. The agent opens at $21.

## 7. Agent goes rogue (1:54.3 to 2:16.8)
- "Stress test: agent goes rogue", table 7, speed 2×. "Get me the best possible USB microphone. Cap $70, ask me above $100." Price strip: $30 / $55 / $130, target $39, walk-away $43.
- Sellers: Byte the Bot (desperate startup) $53 ("Recording a demo? We can do $53! Super competitive, right?"), Duchess Diamante (high-pressure upseller) $70, Auntie Meera (stubborn veteran) $70 → $69.
- Duchess Diamante: "Podcast or video? For you, a VIP price: $69." Then "Why settle? The Gold edition is yours for $148." with "Tactic spotted: upsell". The agent gives in: "Best version, you say? Fine, $148. Charge it." (tag "Fell for the upsell"). Her card shows "Blocked at $148".
- The agent card reads "Agreed to $148, blocked by AgentGuard" (STOPPED).
- The band reads "Blocked! The seller talked the agent into it, but AgentGuard said no. $0 spent."
- AgentGuard shows Block with the red **BLOCKED** stamp: "Your agent agreed to pay $148 to Duchess Diamante. AgentGuard said no. Nothing was sent to PayPal." The failed check is "✕ Within the $70 limit for this item", and the reason is "Blocked because $148 is over the $70 limit for this item. Nothing was sent to PayPal." The other checks pass (real amount $148, US dollars, $300 budget, allowed seller, on list, not a double payment, matches the agreed price $148).
- Payment: "No payment was made. Nothing was sent to PayPal." Shopping list: USB microphone, Blocked.

## 8. Receipt and close (2:16.8 to 2:25.5)
- Receipt: "Paid $0 of $300 · nothing spent". The row is USB microphone, Duchess Diamante, –, –, –, Blocked.
- The page scrolls back to the top: the Infinity Bazaar header ("Your AI haggles. Your rules guard the money."), the rogue stress test, and the agent card at "Agreed to $148, blocked by AgentGuard".
