# @iyexin/mio-api

Web 侧 Mio API 与 bootstrap bridge。

```bash
npm install @iyexin/mio-api
```

```ts
import { Mio, app, fs, clipboard, nativeApi, processApi } from "@iyexin/mio-api";

await Mio.ready;
console.log(await app.info());
await fs.writeText("notes/hello.txt", "hello");
await clipboard.writeText("Hello from the shell");

// Native library with a small scalar ABI (Android + Windows).
const lib = await nativeApi.load("demo");
const sum = await nativeApi.call(lib.handle, "mio_add", "i32(i32,i32)", [2, 3]);

// Windows only: start a sidecar and pipe stdio.
const child = await processApi.spawn({ path: "sidecar/helper.exe" });
await processApi.write(child.id, "ping\n");
await processApi.closeStdin(child.id);
```

- `bootstrap.js` 是零依赖的 classic script，由运行时注入，也可被打包器 import；
- `index.ts` 是类型封装，所有调用返回 Promise；
- `window.Mio` 与 `Mio` 共用同一个 bridge；
- 错误带符号码 `code`（`FS_FORBIDDEN` 等）与数字 `rpcCode`。

完整 API 见仓库 `docs/api.md`。
