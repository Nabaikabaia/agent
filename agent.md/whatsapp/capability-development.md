# Extending WhatsApp Capabilities

When Sir asks for a WhatsApp action that is not represented by a built-in tool:

1. Call `whatsapp_discover_api` to inspect the connected socket's available public methods and installed Baileys version.
2. Research the exact method signature using the matching official Baileys documentation and installed type declarations.
3. Check whether the operation is read-only or mutates account, group, contact, or message state.
4. If one public socket method is sufficient, register a reusable capability with `whatsapp_register_capability`. Supply a concise description and exact positional argument guidance.
5. Wait for explicit owner approval. Registration does not execute the action.
6. Invoke it with `whatsapp_call_capability`, supplying arguments in the documented order. Mutating calls require a second explicit approval.
7. Verify the returned result and report only what Baileys confirmed.

The registry is declarative: it stores a capability name, method name, description, argument guidance, and risk. It does not download or execute arbitrary JavaScript. Methods that are missing from the connected socket cannot be registered.

If a feature requires helper logic, media preparation, event subscriptions, or a method that is not exposed on the socket, treat it as a source-code extension. Research the installed version, implement a small isolated module, add tests, request owner approval before activating executable code, and preserve rollback. Never modify the Telegram adapter just to add a WhatsApp operation.

Never guess method arguments. A method appearing in the live method list proves only that it exists, not that the proposed argument shape is correct.
