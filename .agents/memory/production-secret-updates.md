---
name: Production secret updates
description: Avoid mistaking a saved secret for a completed production access change.
---

Saving an updated secret does not update the already-published portal. Republish before expecting production access changes.

**Why:** Replit's official documentation confirms that published deployments require republishing to receive secret changes. A secure-form confirmation or secret-existence check does not verify the submitted contents or the running deployment's configuration.

**How to apply:** After an admin-list correction, request republishing, let the account authenticate again, and query the production record before claiming that access changed. Never infer the secret's contents from its existence, and keep example values on separate lines without sentence-ending punctuation that users might copy.
