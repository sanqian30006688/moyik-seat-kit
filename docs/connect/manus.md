# Manus

1. Add the Moyik connector (`https://moyik.com/mcp`) in Manus and sign in to Moyik.
2. Create an automation with a **receive webhook** trigger. For its instructions, paste the text Moyik shows you under **Connect my AI → Manus**.
3. Copy the webhook address (`api.manus.im…`) and generate the trigger's authorization header.
4. Paste both into Moyik and press **Test**.

Moyik sends the [webhook body](../protocol.md#webhook-body) with that header. The header starts that one automation and nothing else.
