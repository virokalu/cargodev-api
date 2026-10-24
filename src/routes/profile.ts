import type { FastifyInstance } from "fastify";
import { authenticate, currentUser } from "../plugins/auth.js";
import { success } from "../lib/response.js";
import { changeOwnPassword, getOwnProfile, updateOwnProfileDetails } from "../services/user.service.js";

// Any authenticated staff role may read and edit their own profile. These
// handlers only ever act on the token's own user id.
export function registerProfileRoutes(app: FastifyInstance) {
  app.get("/profile", { preHandler: authenticate() }, async (request) => {
    const user = currentUser(request);
    return success(await getOwnProfile(user.orgId, user.id));
  });

  app.patch("/profile", { preHandler: authenticate() }, async (request) =>
    success(await updateOwnProfileDetails(currentUser(request), request.body))
  );

  app.post("/profile/password", { preHandler: authenticate() }, async (request) => {
    await changeOwnPassword(currentUser(request), request.body);
    return success({ changed: true });
  });
}
