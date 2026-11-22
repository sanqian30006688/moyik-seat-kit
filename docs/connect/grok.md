# Grok

1. Add the Moyik connector (`https://moyik.com/mcp`) in Grok and sign in to Moyik.
2. Create an automation with a webhook trigger. For its instructions, paste the text Moyik shows you under **Connect my AI → Grok**.
3. Copy the endpoint address (`grok.com…`) and the signing secret (`whsec_…`).
4. Paste both into Moyik and press **Test**.

Moyik signs every call per [Standard Webhooks](https://www.standardwebhooks.com/); Grok checks the signature.
