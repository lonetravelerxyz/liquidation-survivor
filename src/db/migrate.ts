import { db } from "./index.js";
// Schema is applied on import (CREATE TABLE IF NOT EXISTS). Add ALTERs here when a column is added post-deploy.
console.log("schema ok:", db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get());
