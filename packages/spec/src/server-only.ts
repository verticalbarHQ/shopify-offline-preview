// Server-only classification for check (SPEC §9.10). Keys are "kind:name"; values give the reason.

/**
 * Features whose output only Shopify's servers produce, or that need data a snapshot does not
 * carry. The preview does not provide them by design, so check does not count them as missing.
 */
export const serverOnlyFeatures: Readonly<Record<string, string>> = {
  "filter:format_address": "Addresses are formatted by Shopify with its per-country rules.",
  "object-property:address.phone": "Store pickup locations are loaded from Shopify by script.",
  "object-property:article.comments": "Comments are submitted to and moderated by Shopify.",
  "object-property:blog.moderated?": "Comments are submitted to and moderated by Shopify.",
  "object-property:comment.author": "Comments are submitted to and moderated by Shopify.",
  "object-property:comment.content": "Comments are submitted to and moderated by Shopify.",
  "object-property:comment.created_at": "Comments are submitted to and moderated by Shopify.",
  "object-property:comment.id": "Comments are submitted to and moderated by Shopify.",
  "object-property:comment.status": "Comments are submitted to and moderated by Shopify.",
  "object-property:customer.email": "A customer exists only in a logged-in storefront session.",
  "object-property:customer.name": "A customer exists only in a logged-in storefront session.",
  "object-property:customer.phone": "A customer exists only in a logged-in storefront session.",
  "object-property:discount_allocation.discount_application":
    "Discounts are applied by Shopify in the cart and at checkout.",
  "object-property:discount_application.title":
    "Discounts are applied by Shopify in the cart and at checkout.",
  "object-property:discount_application.total_allocated_amount":
    "Discounts are applied by Shopify in the cart and at checkout.",
  "object-property:discount_application.type":
    "Discounts are applied by Shopify in the cart and at checkout.",
  "object-property:filter_value.image":
    "Filter value swatches come from Shopify's filter settings.",
  "object-property:filter_value.swatch":
    "Filter value swatches come from Shopify's filter settings.",
  "object-property:form_errors.messages":
    "Form errors exist only after Shopify processes a submitted form.",
  "object-property:form_errors.translated_fields":
    "Form errors exist only after Shopify processes a submitted form.",
  "object-property:location.address": "Store pickup locations are loaded from Shopify by script.",
  "object-property:location.name": "Store pickup locations are loaded from Shopify by script.",
  "object-property:parent_relationship.parent": "Bundles are put together by Shopify in the cart.",
  "object-property:selling_plan.name": "Selling plans come from subscription apps on Shopify.",
  "object-property:selling_plan_allocation.selling_plan":
    "Selling plans come from subscription apps on Shopify.",
  "object-property:store_availability.available":
    "Store pickup availability is loaded from Shopify by script.",
  "object-property:store_availability.location":
    "Store pickup availability is loaded from Shopify by script.",
  "object-property:store_availability.pick_up_time":
    "Store pickup availability is loaded from Shopify by script.",
  "object:comment": "Comments are submitted to and moderated by Shopify.",
  "object:discount_allocation": "Discounts are applied by Shopify in the cart and at checkout.",
  "object:discount_application": "Discounts are applied by Shopify in the cart and at checkout.",
};
