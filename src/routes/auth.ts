import type { FastifyInstance, FastifyRequest } from "fastify";
import { loginMobile, logoutMobile, refreshMobileToken, type RequestMeta } from "../services/mobile-auth.service.js";
import { success } from "../lib/response.js";

// Tighter than the global limit: credential stuffing and token guessing.
const AUTH_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

// Audit trail only (RefreshToken.createdByIp / userAgent). Never a security decision.
function requestMeta(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers["user-agent"];
  return { ip: request.ip, ...(userAgent ? { userAgent } : {}) };
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post("/auth/login", AUTH_RATE_LIMIT, async (request) => {
    return success(await loginMobile(request.body, requestMeta(request)));
  });

  app.post("/auth/refresh", AUTH_RATE_LIMIT, async (request) => {
    return success(await refreshMobileToken(request.body, requestMeta(request)));
  });

  app.post("/auth/logout", AUTH_RATE_LIMIT, async (request) => {
    await logoutMobile(request.body);
    return success({ loggedOut: true });
  });
}
