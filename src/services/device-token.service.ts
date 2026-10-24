// Device token registration for Expo push notifications — CD mobile add-on.
// One row per physical device (not per user): a staff member can be signed
// into more than one phone/tablet, and a push send has to reach all of
// them. lib/expo-push.ts is the only other module allowed to read this
// table (for sending) or delete from it (for pruning dead tokens); no
// mutation on this table happens outside this file.

import { Expo } from "expo-server-sdk";
import { getPrisma } from "../lib/prisma.js";
import { ServiceError } from "../lib/errors.js";
import {
  registerDeviceTokenSchema,
  unregisterDeviceTokenSchema,
} from "../validation/device-token.schema.js";
import { flattenFieldErrors } from "../validation/shared.js";

export interface RegisteredDeviceToken {
  id: string;
  expoPushToken: string;
  platform: string;
  lastSeenAt: Date;
}

/**
 * Registers or refreshes a device's Expo push token for the calling user.
 * Upserts on expoPushToken (unique) rather than on userId — a device
 * getting re-registered under a *different* user (shared tablet, app
 * reinstalled, previous user logged out) should move the token to the new
 * owner and touch lastSeenAt, not create a second row that's still
 * pointing at whoever registered first.
 */
export async function registerDeviceToken(
  orgId: string,
  userId: string,
  rawInput: unknown
): Promise<RegisteredDeviceToken> {
  const parsed = registerDeviceTokenSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceError(
      "VALIDATION",
      "Please provide a valid Expo push token.",
      flattenFieldErrors(parsed.error)
    );
  }
  const { expoPushToken, platform } = parsed.data;

  // A malformed token would otherwise fail silently at send time, days or
  // weeks later — reject it up front instead.
  if (!Expo.isExpoPushToken(expoPushToken)) {
    throw new ServiceError("VALIDATION", "Not a valid Expo push token.", {
      expoPushToken: "Not a valid Expo push token",
    });
  }

  const token = await getPrisma().deviceToken.upsert({
    where: { expoPushToken },
    create: { org_id: orgId, userId, expoPushToken, platform },
    update: { org_id: orgId, userId, platform, lastSeenAt: new Date() },
  });

  return {
    id: token.id,
    expoPushToken: token.expoPushToken,
    platform: token.platform,
    lastSeenAt: token.lastSeenAt,
  };
}

/**
 * Unregisters one device token — called on logout so a signed-out device
 * stops receiving push. Scoped to org+user so a caller can never unregister
 * someone else's token by guessing/sniffing it; idempotent, same treatment
 * as mobile-auth.service.ts's logoutMobile (an already-removed or unknown
 * token isn't an error, the end state is already what was asked for).
 */
export async function unregisterDeviceToken(
  orgId: string,
  userId: string,
  rawInput: unknown
): Promise<void> {
  const parsed = unregisterDeviceTokenSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceError(
      "VALIDATION",
      "A device token is required.",
      flattenFieldErrors(parsed.error)
    );
  }

  await getPrisma().deviceToken.deleteMany({
    where: { expoPushToken: parsed.data.expoPushToken, org_id: orgId, userId },
  });
}

export interface UserDeviceToken {
  userId: string;
  expoPushToken: string;
}

/** Every registered token for the given recipients, across every device each
 * is logged into — used by notification.service.ts's sendMobilePush to build
 * a send list. Keeps userId alongside each token (not just a flat token
 * list) so that send can attach each recipient's own Notification id to
 * their device's push payload — a shared tablet or a user with two phones
 * still only gets its own row's id, never someone else's. */
export async function listDeviceTokensForUsers(orgId: string, userIds: string[]): Promise<UserDeviceToken[]> {
  if (userIds.length === 0) return [];
  return getPrisma().deviceToken.findMany({
    where: { org_id: orgId, userId: { in: userIds } },
    select: { userId: true, expoPushToken: true },
  });
}

/** Called after a send attempt when Expo's ticket/receipt marks a token
 * DeviceNotRegistered (app uninstalled, token rotated) — there's no
 * recovering that token, so it's pruned rather than left to fail forever. */
export async function removeDeviceTokens(expoPushTokens: string[]): Promise<void> {
  if (expoPushTokens.length === 0) return;
  await getPrisma().deviceToken.deleteMany({ where: { expoPushToken: { in: expoPushTokens } } });
}
