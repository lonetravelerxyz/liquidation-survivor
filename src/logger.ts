import pino from "pino";
import { config } from "./config.js";

export const logger = pino(
  config.nodeEnv === "production"
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } },
);
