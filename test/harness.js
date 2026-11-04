import worker, {
  Inbox as BaseInbox,
  Admission as BaseAdmission,
} from "../worker/index.js";
import { LIMITS } from "../worker/shared.js";
export class Admission extends BaseAdmission {
  async testingResetRate() {
    this.ctx.storage.sql.exec("DELETE FROM rate");
    return true;
  }
}
export class Inbox extends BaseInbox {
  async testing(op) {
    const meta = await this.ctx.storage.get("meta");
    if (op === "expire") {
      meta.viewed = Date.now() - LIMITS.ttl;
      await this.ctx.storage.put("meta", meta);
      await this.alarm();
    }
    if (op === "ageRequest") {
      this.ctx.storage.sql.exec(
        "UPDATE requests SET received=?",
        Date.now() - LIMITS.ttl - 1,
      );
      await this.alarm();
    }
    if (op === "resetRate") {
      meta.bucket = 0;
      meta.count = 0;
      await this.ctx.storage.put("meta", meta);
    }
    if (op === "ageHeartbeat") {
      meta.viewed -= 180000;
      await this.ctx.storage.put("meta", meta);
    }
    if (op === "nearExpiry") {
      meta.viewed = Date.now() - LIMITS.ttl + 300000;
      await this.ctx.storage.put("meta", meta);
      await this.schedule(meta);
    }
    if (op === "nearMax") {
      meta.created = Date.now() - LIMITS.maxAge + 300000;
      meta.viewed = Date.now();
      await this.ctx.storage.put("meta", meta);
      await this.schedule(meta);
    }
    if (op === "stats")
      return {
        meta,
        usage: this.ctx.storage.sql
          .exec(
            "SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM requests",
          )
          .one(),
      };
    return { ok: true };
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/reset-create-rate")
      return env.ADMISSION.getByName("global")
        .testingResetRate()
        .then(() => Response.json({ ok: true }));
    if (url.pathname.startsWith("/__test/")) {
      const [, , id, op] = url.pathname.split("/");
      return env.INBOX.getByName(id)
        .testing(op)
        .then((value) => Response.json(value));
    }
    return worker.fetch(request, env);
  },
};
