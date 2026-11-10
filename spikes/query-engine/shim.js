// Emscripten の glue が参照する self.location と document の代わり
if (typeof globalThis.location === "undefined") globalThis.location = { href: "http://worker/" };
