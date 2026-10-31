"""Generates data/catalog.json for Infinity Bazaar from compact item rows.

Prices are USD for late 2026. Items with entries in SOURCES are marked
confidence="researched" with asOf and up to three source pages; the rest stay "estimate".
verifyQuery is a search phrase for checking each price by hand or later by the app.
"""
import json, sys, pathlib

OUT = pathlib.Path(sys.argv[1])

# Seller cost as a share of the typical price, and the minimum margin a seller accepts.
COST = {
    "gear":     {"costShare": [0.60, 0.72], "minMargin": 0.08},
    "digital":  {"costShare": [0.25, 0.45], "minMargin": 0.20},
    "online":   {"costShare": [0.35, 0.55], "minMargin": 0.15},
    "credits":  {"costShare": [0.80, 0.90], "minMargin": 0.05},
    "freelance":{"costShare": [0.55, 0.75], "minMargin": 0.10},
    "food":     {"costShare": [0.50, 0.65], "minMargin": 0.10},
    "merch":    {"costShare": [0.50, 0.65], "minMargin": 0.12},
}

PAY_NOW = {"shipping", "setup", "delivery"}
# Certain later costs. Every other hidden fee is a condition (only if you return it,
# exceed a limit, etc.): shown as a term, not counted as money.
LATER = {"renewal", "commercial", "usage", "source-fee"}

def fee_kind(fid):
    return "now" if fid in PAY_NOW else "later" if fid in LATER else "conditional"

GROUPS = {
    "online": "Online services",
    "design": "Design",
    "gear": "Gear",
    "freelancers": "Freelancers",
    "fun": "Team and fun",
}

# id, name, group, unit, delivery, low, typical, high, cost profile, seller types,
# levers [(id, label, usd value)], hidden fees [(id, label, usd)], description
ROWS = [
  # ---- Online services
  ("domain-dev", ".dev domain name", "online", "1 year", "instant", 10, 13, 21, "online",
   ["reseller", "big-brand", "desperate-startup"],
   [("privacy", "Free WHOIS privacy", 5), ("renewal-lock", "Renewal price locked", 6)],
   [("renewal", "Renewal price far above first-year price", 6)],
   "A memorable domain for the project's demo link."),
  ("hosting-starter", "Starter web hosting", "online", "1 year", "instant", 23, 45, 144, "online",
   ["big-brand", "desperate-startup", "reseller"],
   [("ssl", "Free SSL certificate", 10), ("backups", "Daily backups", 12), ("extra-month", "2 extra months", 10)],
   [("renewal", "Renewal at full list price", 22), ("setup", "One-time setup fee", 15)],
   "Hosting for the landing page and API."),
  ("domain-hosting", "Domain and hosting bundle", "online", "1 year", "instant", 23, 48, 144, "online",
   ["big-brand", "desperate-startup", "reseller"],
   [("ssl", "Free SSL certificate", 10), ("renewal-lock", "Renewal price locked", 15), ("support", "Priority support", 8)],
   [("renewal", "Renewal price far above first-year price", 14)],
   "A domain plus a year of hosting in one purchase."),
  ("ai-credits", "AI API credits", "online", "$50 of credits", "instant", 40, 50, 55, "credits",
   ["big-brand", "reseller", "desperate-startup"],
   [("bonus", "Bonus credits", 10), ("rollover", "Credits never expire", 5)],
   [("expiry", "Credits expire in 30 days", 15)],
   "Credits to power the app's AI agents during the hackathon."),
  ("database-plan", "Managed database plan", "online", "3 months", "instant", 15, 57, 75, "online",
   ["big-brand", "desperate-startup", "reseller"],
   [("storage", "Double storage", 15), ("backups", "Point-in-time backups", 15)],
   [("egress", "Data transfer billed separately", 15)],
   "A hosted database for user and deal data."),
  ("email-service", "Transactional email service", "online", "3 months", "instant", 45, 60, 105, "online",
   ["big-brand", "desperate-startup", "reseller"],
   [("volume", "Higher sending limit", 15), ("domain-setup", "Free domain verification help", 10)],
   [("overage", "Overage fees past the limit", 15)],
   "Sends receipts and alerts to users."),
  ("uptime-monitor", "Uptime monitoring", "online", "1 year", "instant", 84, 108, 156, "online",
   ["big-brand", "desperate-startup", "reseller"],
   [("sms", "SMS alerts included", 24), ("status-page", "Public status page", 24)],
   [],
   "Alerts if the demo goes down during judging."),
  ("pro-inbox", "Custom-domain email inbox", "online", "1 year", "instant", 12, 48, 101, "online",
   ["big-brand", "reseller", "desperate-startup"],
   [("extra-alias", "Extra aliases", 6), ("storage", "More storage", 8)],
   [("renewal", "Renewal at full list price", 8)],
   "A professional contact address for the team."),

  # ---- Design
  ("ui-template", "UI template pack", "design", "1 license", "instant", 19, 35, 299, "digital",
   ["upseller", "desperate-startup", "big-brand"],
   [("updates", "Lifetime updates", 10), ("figma", "Figma source files", 12), ("extended", "Extended license", 20)],
   [("commercial", "Commercial use costs extra", 12)],
   "Polished screens so the app looks finished fast."),
  ("icon-set", "Icon set license", "design", "1 license", "instant", 19, 39, 228, "digital",
   ["desperate-startup", "upseller", "big-brand"],
   [("svg", "Editable SVG sources", 8), ("extended", "Extended license", 20)],
   [("attribution", "Attribution required unless you pay more", 15)],
   "A consistent icon style across the app."),
  ("stock-video", "Stock video clips", "design", "5 clips", "instant", 42, 150, 500, "digital",
   ["big-brand", "upseller", "desperate-startup"],
   [("4k", "4K versions", 30), ("extra-clip", "One extra clip", 30)],
   [("per-project", "License covers one project only", 40)],
   "B-roll for the demo video."),
  ("font-license", "Web font license", "design", "1 license", "instant", 25, 49, 150, "digital",
   ["stubborn-veteran", "upseller", "big-brand"],
   [("weights", "All weights included", 20), ("app", "App embedding allowed", 25)],
   [("pageviews", "Pageview cap on the web license", 30)],
   "A distinctive typeface for the brand."),
  ("music-track", "Background music license", "design", "1 track", "instant", 19, 49, 199, "digital",
   ["desperate-startup", "big-brand", "upseller"],
   [("stems", "Separate stems", 10), ("youtube", "Pre-cleared for YouTube", 8)],
   [("monetization", "YouTube use needs a higher tier", 20)],
   "Music under the demo video."),
  ("illustration-pack", "Illustration pack", "design", "1 license", "instant", 25, 35, 65, "digital",
   ["desperate-startup", "upseller", "stubborn-veteran"],
   [("custom-colors", "Recolored to the brand", 15), ("extra-scenes", "Extra scenes", 10)],
   [],
   "Characters for the merchants and agents."),
  ("deck-template", "Pitch deck template", "design", "1 license", "instant", 12, 39, 199, "digital",
   ["desperate-startup", "upseller", "big-brand"],
   [("charts", "Editable chart slides", 6), ("keynote", "Keynote and Google Slides versions", 5)],
   [],
   "Slides for the pitch section of the video."),
  ("device-mockups", "Device mockup pack", "design", "1 license", "instant", 14, 25, 51, "digital",
   ["desperate-startup", "upseller", "big-brand"],
   [("animated", "Animated mockups", 10), ("extra-devices", "More devices", 6)],
   [],
   "Shows the app on phones and laptops in the video."),

  # ---- Gear
  ("usb-mic", "USB microphone", "gear", "1 unit", "shipped", 30, 55, 130, "gear",
   ["stubborn-veteran", "desperate-startup", "upseller"],
   [("pop-filter", "Pop filter included", 8), ("free-shipping", "Free shipping", 6), ("warranty", "Extra year of warranty", 10)],
   [("shipping", "Shipping added at checkout", 9)],
   "Clear voice for the demo video."),
  ("webcam", "1080p webcam", "gear", "1 unit", "shipped", 50, 59, 100, "gear",
   ["big-brand", "desperate-startup", "upseller"],
   [("free-shipping", "Free shipping", 6), ("privacy-cover", "Privacy cover and tripod", 7)],
   [("shipping", "Shipping added at checkout", 8)],
   "Face-cam footage for the pitch."),
  ("ring-light", "Ring light with stand", "gear", "1 unit", "shipped", 33, 40, 140, "gear",
   ["desperate-startup", "stubborn-veteran", "upseller"],
   [("free-shipping", "Free shipping", 5), ("phone-holder", "Phone holder", 4)],
   [("shipping", "Shipping added at checkout", 7)],
   "Even lighting for video calls and recording."),
  ("green-screen", "Collapsible green screen", "gear", "1 unit", "shipped", 28, 50, 130, "gear",
   ["stubborn-veteran", "desperate-startup", "big-brand"],
   [("free-shipping", "Free shipping", 6), ("stand", "Mounting stand", 10)],
   [("shipping", "Oversize shipping fee", 12)],
   "Clean backgrounds for the demo video."),
  ("mic-arm", "Microphone boom arm", "gear", "1 unit", "shipped", 25, 35, 129, "gear",
   ["desperate-startup", "stubborn-veteran", "upseller"],
   [("free-shipping", "Free shipping", 5), ("cable-clips", "Cable management clips", 3)],
   [],
   "Keeps the mic steady and out of frame."),
  ("usb-c-hub", "USB-C hub", "gear", "1 unit", "shipped", 20, 30, 75, "gear",
   ["big-brand", "desperate-startup", "upseller"],
   [("free-shipping", "Free shipping", 5), ("warranty", "Extra year of warranty", 6)],
   [],
   "More ports for the mic, camera and second screen."),
  ("headphones", "Noise-cancelling headphones", "gear", "1 unit", "shipped", 68, 100, 400, "gear",
   ["upseller", "big-brand", "stubborn-veteran"],
   [("case", "Carrying case", 10), ("free-shipping", "Free shipping", 6), ("warranty", "Extra year of warranty", 12)],
   [("restocking", "Restocking fee on returns", 15)],
   "Focus during long build sessions."),
  ("portable-monitor", "15.6-inch portable monitor", "gear", "1 unit", "shipped", 89, 130, 209, "gear",
   ["big-brand", "upseller", "desperate-startup"],
   [("sleeve", "Protective sleeve", 12), ("free-shipping", "Free shipping", 10), ("warranty", "Extra year of warranty", 15)],
   [("restocking", "Restocking fee on returns", 20)],
   "A second screen for coding and testing."),
  ("laptop-stand", "Adjustable laptop stand", "gear", "1 unit", "shipped", 15, 37, 60, "gear",
   ["desperate-startup", "stubborn-veteran", "big-brand"],
   [("free-shipping", "Free shipping", 5)],
   [],
   "Puts the webcam at eye level."),

  # ---- Freelancers
  ("video-editor", "Video editor for a 3-minute demo", "freelancers", "1 video", "service", 70, 150, 300, "freelance",
   ["pro-freelancer", "volume-studio", "student-freelancer"],
   [("revision", "One extra revision", 20), ("rush", "Faster delivery", 30), ("captions", "Burned-in captions", 15)],
   [("revision-fee", "Revisions billed separately", 30)],
   "Turns raw screen recordings into a tight demo video."),
  ("logo-designer", "Logo design", "freelancers", "1 logo", "service", 35, 100, 500, "freelance",
   ["pro-freelancer", "volume-studio", "student-freelancer"],
   [("concepts", "Extra concepts", 25), ("source", "Source files", 20), ("revision", "One extra revision", 15)],
   [("source-fee", "Source files cost extra", 20)],
   "A mark for Infinity Bazaar."),
  ("copywriter", "Landing page copywriter", "freelancers", "1 page", "service", 100, 250, 800, "freelance",
   ["pro-freelancer", "volume-studio", "student-freelancer"],
   [("revision", "One extra revision", 40), ("devpost", "Devpost write-up included", 60)],
   [],
   "Clear words for the landing page and submission."),
  ("pitch-coach", "Pitch coaching session", "freelancers", "1 hour", "service", 45, 100, 300, "freelance",
   ["pro-freelancer", "student-freelancer", "volume-studio"],
   [("followup", "Follow-up review of the final video", 40), ("script", "Script feedback", 20)],
   [],
   "Practice the 3-minute story before recording."),
  ("voiceover", "Voice-over artist", "freelancers", "3 minutes", "service", 50, 120, 450, "freelance",
   ["pro-freelancer", "volume-studio", "student-freelancer"],
   [("retake", "Free retake", 20), ("rush", "24-hour delivery", 30)],
   [("usage", "Commercial usage fee", 25)],
   "A professional narrator for the demo video."),
  ("ux-review", "UX review of the app", "freelancers", "1 review", "service", 200, 350, 1040, "freelance",
   ["pro-freelancer", "student-freelancer", "volume-studio"],
   [("video", "Recorded walkthrough", 60), ("followup", "Second review after fixes", 100)],
   [],
   "Fresh eyes on the deal room screen."),
  ("motion-intro", "Animated logo intro", "freelancers", "10 seconds", "service", 50, 120, 400, "freelance",
   ["volume-studio", "pro-freelancer", "student-freelancer"],
   [("sound", "Sound effect included", 10), ("variant", "Vertical version", 20)],
   [],
   "A short branded opening for the video."),
  ("qa-tester", "QA tester", "freelancers", "1 day", "service", 216, 400, 1040, "freelance",
   ["student-freelancer", "volume-studio", "pro-freelancer"],
   [("devices", "Testing on more devices", 60), ("report", "Written bug report", 40)],
   [],
   "Finds bugs before the judges do."),

  # ---- Team and fun
  ("pizza", "Pizza for the team", "fun", "4 large pizzas", "shipped", 40, 58, 80, "food",
   ["friendly-local", "big-brand", "desperate-startup"],
   [("drinks", "Free drinks", 8), ("free-delivery", "Free delivery", 6), ("dessert", "Free dessert", 7)],
   [("delivery", "Delivery and service fees", 10)],
   "Fuel for the all-nighter."),
  ("energy-drinks", "Energy drinks", "fun", "12-pack", "shipped", 20, 24, 28, "food",
   ["friendly-local", "big-brand", "desperate-startup"],
   [("free-delivery", "Free delivery", 5), ("extra-cans", "Four extra cans", 8)],
   [],
   "Caffeine for the final push."),
  ("hoodies", "Team hoodies", "fun", "4 hoodies", "shipped", 83, 140, 220, "merch",
   ["bulk-merch", "upseller", "friendly-local"],
   [("print-back", "Back print included", 20), ("free-shipping", "Free shipping", 12), ("rush", "Rush production", 25)],
   [("setup", "Print setup fee", 25)],
   "Matching Infinity Bazaar hoodies for the photo."),
  ("stickers", "Die-cut stickers", "fun", "100 stickers", "shipped", 25, 45, 75, "merch",
   ["bulk-merch", "desperate-startup", "friendly-local"],
   [("extra-50", "50 extra stickers", 12), ("free-shipping", "Free shipping", 6)],
   [("setup", "Die setup fee", 15)],
   "Giveaways with the logo."),
  ("coffee", "Specialty coffee beans", "fun", "1 kg", "shipped", 30, 45, 75, "food",
   ["friendly-local", "stubborn-veteran", "big-brand"],
   [("grind", "Ground to order", 3), ("free-delivery", "Free delivery", 5)],
   [],
   "Better coffee than the office machine."),
  ("cowork-pass", "Coworking day pass", "fun", "2 people", "service", 34, 64, 150, "food",
   ["friendly-local", "big-brand", "desperate-startup"],
   [("meeting-room", "One hour of meeting room", 20), ("coffee", "Unlimited coffee", 6)],
   [],
   "A quiet place to record the video."),
  ("cake", "Celebration cake", "fun", "1 cake", "shipped", 16, 30, 60, "food",
   ["friendly-local", "stubborn-veteran", "upseller"],
   [("custom-text", "Custom message on top", 5), ("free-delivery", "Free delivery", 6)],
   [],
   "For when the submission goes in."),
]

# Where each price range comes from. Every URL was returned by a web search in October 2026.
# An item without an entry keeps confidence="estimate".
SOURCES = {
  "domain-dev": [
    ("Porkbun .dev price on Domainoffer (first year $9.81, renewal $12.87)", "https://domainoffer.net/tld/dev/porkbun"),
    (".dev price comparison across registrars (Namecheap renewal $21.18, Cloudflare $12.20)", "https://costgoat.com/compare/domains/dev"),
    ("Porkbun domain cost calculator for .dev", "https://porkbun.com/about/domain-cost-calculator/dev"),
  ],
  "hosting-starter": [
    ("Namecheap shared hosting (Stellar $22.88 first year, renews $44.88)", "https://NameCheap.com/hosting/shared"),
    ("Hostinger pricing 2026 (Premium from $2.99/mo, $10.99-11.99/mo standard)", "https://www.websitebuilderexpert.com/web-hosting/hostinger-pricing/"),
  ],
  "domain-hosting": [
    ("Namecheap shared hosting with a domain offer ($22.88 first year)", "https://NameCheap.com/hosting/shared"),
    ("Hostinger Premium 12 months $47.88 with free domain (regular $143.88)", "https://bloggerspassion.com/best-web-hosting/hostinger-pricing-plans-explained/"),
    ("Hostinger: how to get a free domain", "https://www.hostinger.com/support/1583407-how-to-register-a-domain-for-free/"),
  ],
  "ai-credits": [
    ("OpenAI prepaid billing (credits at face value, $5 minimum, expire after 1 year)", "https://help.openai.com/en/articles/8264778-what-is-prepaid-billing?app=1"),
    ("Anthropic: paying for Claude API usage with prepaid credits", "https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage"),
  ],
  "database-plan": [
    ("Supabase pricing (Pro $25/month)", "https://supabase.com/pricing"),
    ("Neon pricing (Launch from about $19/month, usage-based)", "https://neon.com/pricing"),
  ],
  "email-service": [
    ("Postmark pricing (10,000 emails for $15/month)", "https://postmarkapp.com/pricing.txt"),
    ("Resend pricing (Pro $20/month for 50,000 emails)", "https://www.resend.com/pricing.md"),
    ("SendGrid pricing 2026 (Essentials $19.95/month)", "https://www.usecarly.com/blog/sendgrid-pricing/"),
  ],
  "uptime-monitor": [
    ("UptimeRobot pricing", "https://uptimerobot.com/pricing.md"),
    ("UptimeRobot pricing 2026 (Solo about $9/month billed annually)", "https://notifier.so/guides/uptimerobot-pricing-2026/"),
    ("UptimeRobot pricing review, Aug 2026 (Solo $12-13/month)", "https://hyperping.com/blog/uptimerobot-pricing"),
  ],
  "pro-inbox": [
    ("Zoho Mail pricing (Mail Lite $1, Mail Premium $4 per user/month)", "https://www.capterra.com/p/174694/Zoho-Mail/pricing/"),
    ("Google Workspace pricing 2026 (Business Starter $7 annual, $8.40 monthly)", "https://www.cloudwards.net/google-workspace-plans-and-pricing/"),
  ],
  "ui-template": [
    ("ThemeForest admin dashboard template, Regular License $35", "https://themeforest.net/item/infinio-bootstrap-4-admin-dashboard-template/21824011"),
    ("ThemeForest admin template, Regular License $19", "https://themeforest.net/item/epic-able-bootstrap-admin-dashboard-template/25795605"),
    ("Tailwind Plus, one-time $299", "https://tailwindcss.com/plus"),
  ],
  "icon-set": [
    ("Streamline pricing (Pro from $19/month, $228/year)", "https://help.streamlinehq.com/en/articles/5634634-what-s-the-pricing-for-streamline-4-0-plans"),
    ("Noun Project pricing (Pro removes attribution)", "https://costbench.com/software/design/noun-project/"),
  ],
  "stock-video": [
    ("Pond5 per-clip prices ($25-200 per clip)", "https://subger.com/en/service/pond5"),
    ("How much stock footage costs", "https://www.footagesecrets.com/buyers-guide/how-much-does-stock-footage-cost/"),
    ("Storyblocks plans 2026 (from $42/month)", "https://pricingsaas.com/companies/videoblocks"),
  ],
  "font-license": [
    ("Emigre web font license (single font, 100k pageviews, $49)", "https://emigre.com/License/Web"),
    ("Font pricing 2026 (web license $30-150 per weight)", "https://madegooddesigns.com/how-much-do-fonts-cost/"),
    ("MyFonts licensing options (pageview tiers)", "https://myfonts.com/pages/fontshop-font-formats-and-licensing-options"),
  ],
  "music-track": [
    ("PremiumBeat single-track licenses (Standard $49)", "https://www.PremiumBeat.com/license"),
    ("PremiumBeat review (Standard $49, Premium $199)", "https://photutorial.com/premiumbeat-review"),
    ("AudioJungle music licenses", "https://audiojungle.net/licenses/music"),
  ],
  "illustration-pack": [
    ("Getillustrations packs ($25, $35, $65 with commercial license)", "https://getillustrations.com/illustration-pack/colorwave-vector-talavera-pattern-illustrations"),
    ("Creative Market graphics and illustrations", "https://creativemarket.com/graphics-illustrations"),
  ],
  "deck-template": [
    ("50Folds pitch deck template ($39)", "https://50folds.gumroad.com/l/pitchdeck"),
    ("Modern Pitch Deck, Keynote and PowerPoint ($199)", "https://pitchworks.gumroad.com/l/modern"),
    ("VIP.graphics SaaS startup deck templates (from $12)", "https://vip.graphics/?p=7684"),
  ],
  "device-mockups": [
    ("Creative Market iPhone, MacBook and poster mockups ($39)", "https://creativemarket.com/feelthis/281505709-iPhone-MacBook-Poster-Mockups"),
    ("All-in-one Apple device mockup bundle ($24.95, was $50.85)", "https://walidthrdedign.gumroad.com/l/mbwkbg"),
  ],
  "usb-mic": [
    ("Blue Yeti vs Fifine K669B (K669B about $30-40)", "https://streamtechreviews.com/blog/blueyetivsfifine669b"),
    ("Best budget USB microphones 2026", "https://fone.tips/best-budget-usb-microphone/"),
  ],
  "webcam": [
    ("Best Buy: Logitech C920s Pro 1080p webcam", "https://www.bestbuy.com/product/-/6321794"),
    ("Logitech C920s price history ($49.99-69.99)", "https://aislegopher.com/p/logitech-c920s-pro-hd-webcam-with-privacy-shutter-black/517120"),
  ],
  "ring-light": [
    ("Walmart Neewer ring lights (10-inch kits about $33-46)", "https://www.walmart.com/c/kp/neewer-ring-light"),
    ("Neewer RL-18 18-inch ring light kit ($139.99)", "https://neewer.com/products/led-ring-lights-66600024"),
  ],
  "green-screen": [
    ("Neewer 5x7 ft collapsible backdrop (from $69.99)", "https://neewer.com/products/lighting-studio-66600789"),
    ("Neewer background screens (collapsible backdrops from $27.99)", "https://neewer.com/collections/background-screen"),
    ("Neewer pull-up green screen ($129.99)", "https://neewer.com/products/neewer-148x180cm-green-screen-green-pull-up-style-10097406"),
  ],
  "mic-arm": [
    ("Best microphone boom arms 2026 (InnoGear about $35)", "https://www.musicianwave.com/best-microphone-boom-arms/"),
    ("Rode PSA1+ studio arm ($99-129)", "https://www.zzounds.com/productreview--RODPSA1PLUS"),
  ],
  "usb-c-hub": [
    ("Anker USB-C Hub 7-in-1 ($25.99)", "https://www.anker.com/products/a83d2-usb-c-hub-7-in-1"),
    ("Anker 7-in-1 USB-C hub at $20", "https://pcworld.com/article/3148232/this-7-in-1-anker-usb-c-hub-is-now-20-a-simple-fix-for-port-starved-laptops.html"),
  ],
  "headphones": [
    ("Sony WH-CH720N vs Soundcore Space One, noise-cancelling under $100", "https://everydaytechessentials.blogspot.com/2026/03/sony-wh-ch720n-vs-soundcore-space-one.html"),
    ("Soundcore Space One at $68 on sale", "https://rss.boorghani.com/?p=371086"),
    ("Soundcore Space One ($99) vs Sony WH-1000XM5 ($399)", "https://chaindesk.ai/tools/youtube-summarizer/99-soundcore-space-one-vs-399-sony-wh-1000-xm-5-xk-SEC1riIA"),
  ],
  "portable-monitor": [
    ("ASUS ZenScreen 15.6-inch drops to $169", "https://www.technobezz.com/best/asus-zenscreen-156-inch-1080p-portable-usb-monitor-drops-to-169"),
    ("Arzopa 15.6-inch portable monitor ($129.99, May 2026)", "https://findsera-com.pages.dev/products/arzopa-portable-monitor-15-6"),
    ("Best budget and expensive portable monitors 2026", "https://bgr.com/2119644/best-budget-expensive-portable-monitors-2026"),
  ],
  "laptop-stand": [
    ("Rain Design mStand vs Nulaxy C1 ($48.88 vs $36.99, checked 2026)", "https://frontdeskreview.com/gear/laptop-stands/rain-design-mstand-vs-nulaxy-c1/"),
    ("Best laptop stands 2026 (Amazon Basics about $15)", "https://boredom-at-work.com/best-laptop-stands/"),
  ],
  "video-editor": [
    ("Fiverr: how much a video editor costs", "https://www.fiverr.com/resources/guides/video-animation/video-editor-cost"),
    ("Video editing rates 2026", "https://www.sidestackers.com/blog/video-editing-rates"),
  ],
  "logo-designer": [
    ("Fiverr: cost to hire a brand designer", "https://www.fiverr.com/resources/guides/costs/brand-designer"),
    ("How much a logo design costs", "https://websiteplanet.com/blog/how-much-is-logo-design"),
  ],
  "copywriter": [
    ("Cost of hiring a copywriter 2026 (marketplace landing page $100-800)", "https://stealthagents.com/research/cost-of-hiring-a-copywriter-2026"),
    ("Copywriter rates 2026", "https://www.sidestackers.com/blog/copywriter-rates"),
  ],
  "pitch-coach": [
    ("Wyzant public speaking coach ($50/hour)", "https://www.wyzant.com/Tutors/NC/Raleigh/9147055"),
    ("Thumbtack speech coaching ($170/hour)", "https://www.thumbtack.com/or/tualatin/public-speaking-training/silva-speech-coaching-50-off-deal/service/403571458818793485"),
  ],
  "voiceover": [
    ("Voice-over pricing guide 2026 (per finished minute)", "https://voicebros.com/en/blog/voice-over-pricing-guide-2026"),
    ("Voice-over artist rate guide 2026", "https://www.sidestackers.com/rates/voice-over-artist"),
  ],
  "ux-review": [
    ("Fiverr website UI/UX audit ($200-400)", "https://fiverr.com/rmorrisdesign/do-a-ux-and-visual-design-audit-of-your-website"),
    ("Contra UX/UI audit (from $345, premium $1,040)", "https://contra.com/s/Uq6Q2o7E-ux-ui-audit"),
  ],
  "motion-intro": [
    ("Fiverr clean logo reveal animation", "https://fiverr.com/sergiymoroz/animate-your-logo-icon"),
    ("Fiverr custom 2D logo animation", "https://fiverr.com/denys_mv/create-stunning-motion-graphics-and-animations"),
  ],
  "qa-tester": [
    ("Freelance QA tester rates 2026 (junior $50-80/hour)", "https://softwaretestpilot.com/blog/career-interview-prep/freelance-qa-tester-rates-how-much-to-charge"),
    ("QA tester salary in the US (about $27/hour)", "https://www.salary.com/research/salary/recruiting/qa-tester-salary"),
  ],
  "pizza": [
    ("Domino's menu with prices (large $13.99, specialty $18.99)", "https://menupedia.us/dominos-menu/"),
    ("Domino's large any-topping pizza deal at $9.99", "https://slickdeals.net/f/18111496-domino-s-pizza-large-any-crust-any-toppings-pizza-for-9-99-carryout-and-delivery"),
  ],
  "energy-drinks": [
    ("Walmart: Red Bull 8.4 oz, 12 pack", "https://www.walmart.com/ip/199527547"),
    ("Farm and Fleet: Red Bull 8.4 oz 12-pack ($24.99)", "https://www.farmandfleet.com/products/1243801-red-bull-84-oz-energy-drink-12-pack.html"),
  ],
  "hoodies": [
    ("Printful custom hoodies (from $20.75)", "https://www.printful.com/custom-hoodies"),
    ("Custom Ink bulk custom hoodies guide", "https://www.customink.com/blog/bulk-custom-hoodies-guide/"),
  ],
  "stickers": [
    ("100 custom 3-inch die-cut stickers for $25 (sale)", "https://customstickers.com/products/100x-3in-for-25"),
    ("Sticker Mule review 2026 (100 die-cut 3x3 for $73)", "https://bootstrappingecommerce.com/?p=14284"),
  ],
  "coffee": [
    ("Mandheling coffee price 2026 (retail about $52/kg)", "https://fnb.coffee/blog/mandheling-coffee-price-2026"),
    ("Gayo wine coffee price 2026 ($32-54/kg)", "https://fnb.tech/gayo-wine-coffee-price"),
  ],
  "cowork-pass": [
    ("WeWork coworking in the United States (day pass from about $39)", "https://www.wework.com/vi-VN/l/coworking-space/united-states"),
    ("Coworking costs in the 25 largest US metros (day pass average about $32)", "https://buildremote.co/?p=8172"),
  ],
  "cake": [
    ("Costco cakes prices 2026 (half sheet $27.99)", "https://costcoguides.com/costco-cakes-prices/"),
    ("Costco vs Walmart: cheapest bakery cake 2026", "https://www.thedailymeal.com/2281697/costco-vs-walmart-cheapest-cake-2026/"),
  ],
}

AS_OF = "2026-10"

# How each item reads inside a sentence ("I'm shopping for ...").
PHRASES = {
    "domain-dev": "a .dev domain name", "hosting-starter": "starter web hosting",
    "domain-hosting": "a domain and hosting bundle", "ai-credits": "AI API credits",
    "database-plan": "a managed database plan", "email-service": "a transactional email service",
    "uptime-monitor": "uptime monitoring", "pro-inbox": "a custom-domain email inbox",
    "ui-template": "a UI template pack", "icon-set": "an icon set license",
    "stock-video": "stock video clips", "font-license": "a web font license",
    "music-track": "a background music license", "illustration-pack": "an illustration pack",
    "deck-template": "a pitch deck template", "device-mockups": "a device mockup pack",
    "usb-mic": "a USB microphone", "webcam": "a 1080p webcam", "ring-light": "a ring light",
    "green-screen": "a green screen", "mic-arm": "a mic boom arm", "usb-c-hub": "a USB-C hub",
    "headphones": "noise-cancelling headphones", "portable-monitor": "a portable monitor",
    "laptop-stand": "a laptop stand", "video-editor": "a video editor for a 3-minute demo",
    "logo-designer": "a logo designer", "copywriter": "a landing page copywriter",
    "pitch-coach": "a pitch coaching session", "voiceover": "a voice-over artist",
    "ux-review": "a UX review", "motion-intro": "an animated logo intro",
    "qa-tester": "a QA tester for a day", "pizza": "pizza for the team",
    "energy-drinks": "a 12-pack of energy drinks", "hoodies": "team hoodies",
    "stickers": "die-cut stickers", "coffee": "specialty coffee beans",
    "cowork-pass": "a coworking day pass", "cake": "a celebration cake",
}

KEEP_CASE = ("SSL", "SMS", "WHOIS", "Figma", "Keynote", "YouTube", "4K", "Devpost")

def phrase(label):
    """Label as it reads mid-sentence: no trailing 'included', lower-case first word unless a name."""
    if label.endswith(" included"):
        label = label[: -len(" included")]
    if label.startswith(KEEP_CASE):
        return label
    return label[0].lower() + label[1:]


def price_block(iid, low, typ, high):
    price = {"currency": "USD", "low": low, "typical": typ, "high": high}
    src = SOURCES.get(iid)
    if not src:
        return {**price, "confidence": "estimate"}
    return {**price, "confidence": "researched", "asOf": AS_OF,
            "sources": [{"title": t, "url": u} for t, u in src]}


def floor_range(typ, prof):
    lo, hi = prof["costShare"]
    m = prof["minMargin"]
    return [round(typ * lo * (1 + m), 2), round(typ * hi * (1 + m), 2)]

items = []
for (iid, name, group, unit, delivery, low, typ, high, prof, sellers, levers, fees, desc) in ROWS:
    p = COST[prof]
    items.append({
        "id": iid,
        "name": name,
        "phrase": PHRASES[iid],
        "group": group,
        "unit": unit,
        "description": desc,
        "delivery": delivery,
        "paypalFlow": "capture_now" if delivery == "instant" else "authorize_then_capture_on_delivery",
        "price": price_block(iid, low, typ, high),
        "verifyQuery": f"{name} {unit} price",
        "seller": {"costProfile": prof, "costShare": p["costShare"], "minMargin": p["minMargin"],
                   "floorRange": floor_range(typ, p)},
        "sellerTypes": sellers,
        "levers": [{"id": a, "label": phrase(b), "valueUsd": c} for a, b, c in levers],
        # kind: "now" (charged at checkout), "later" (a certain later cost), "conditional" (a term).
        "hiddenFees": [{"id": a, "label": phrase(b), "valueUsd": c, "payNow": a in PAY_NOW, "kind": fee_kind(a)} for a, b, c in fees],
    })

catalog = {
    "version": 1,
    "updated": "2026-10-31",
    "note": "Prices are USD. confidence=researched means the range comes from the listed source pages (price.sources, checked price.asOf); confidence=estimate means no source was found. verifyQuery is a search phrase for checking each price.",
    "groups": [{"id": k, "name": v} for k, v in GROUPS.items()],
    "items": items,
}
OUT.write_text(json.dumps(catalog, indent=2) + "\n")
print(f"wrote {len(items)} items to {OUT}")
