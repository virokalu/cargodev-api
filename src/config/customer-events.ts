// The notifications a customer can receive, in one place. `toggleable` events can be switched off one by one in the
// customer's preferences; the others (what a customer asked for and is waiting on) are always delivered in the app,
// though the push and email CHANNELS can still be switched off. Staff events are not listed and never reach a customer.

export const CUSTOMER_EVENTS = {
  BOOKING_RECEIVED: { toggleable: true },
  PHOTOS_ADDED: { toggleable: true },
  DOCUMENTS_READY: { toggleable: true },
  DEPARTURE_REMINDER: { toggleable: true },
  NEW_STOCK: { toggleable: true },
  CHAT_MESSAGE: { toggleable: true },
  LINK_REQUEST_APPROVED: { toggleable: false },
  LINK_REQUEST_REJECTED: { toggleable: false },
} as const;

export type CustomerEvent = keyof typeof CUSTOMER_EVENTS;

export const TOGGLEABLE_EVENTS = (Object.keys(CUSTOMER_EVENTS) as CustomerEvent[]).filter((event) => CUSTOMER_EVENTS[event].toggleable);

export const DEPARTURE_LEAD_DAYS = [3, 7, 14] as const;
export const DEFAULT_DEPARTURE_LEAD_DAYS = 7;

export function isCustomerEvent(event: string): event is CustomerEvent {
  return Object.prototype.hasOwnProperty.call(CUSTOMER_EVENTS, event);
}
