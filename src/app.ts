import express, { type Express } from "express";
import cors from "cors";
import morgan from "morgan";
import { json, urlencoded } from "express";
import i18next from "i18next";
import Backend from "i18next-fs-backend";
import middleware from "i18next-http-middleware";
import path from "path";
import { errorMiddleware, notFoundMiddleware } from "./middlewares/error.middleware";
import { CORS_ORIGINS, LOCAL_STORAGE_PATH, STORAGE_DRIVER } from "./utils/consts";
import { loggerMiddleware } from "./middlewares/logger.middleware";
import routes from "./routes";

export const app: Express = express();

i18next
  .use(Backend)
  .use(middleware.LanguageDetector)
  .init({
    fallbackLng: "en",
    preload: ["en", "bn"],
    backend: {
      loadPath: path.join(__dirname, "locales/{{lng}}/translation.json"),
    },
    detection: {
      order: ["querystring", "cookie", "header"],
      caches: ["cookie"],
    },
  });

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cors({ origin: CORS_ORIGINS }));
app.use(json({ limit: "64kb" }));
app.use(urlencoded({ extended: true }));
if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));
app.use(middleware.handle(i18next));
app.use(loggerMiddleware);
// Local image storage (dev / tests). Production images are served by Supabase Storage.
if (STORAGE_DRIVER === "local") app.use("/media", express.static(LOCAL_STORAGE_PATH, { maxAge: "365d", immutable: true, fallthrough: false }));
app.use(routes);
app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;