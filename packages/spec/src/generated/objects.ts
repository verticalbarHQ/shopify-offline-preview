// Generated from Shopify/theme-liquid-docs@e729cbf736095ecca9ec84a2fff658e155c8e54f. Do not edit.
// Documentation types are optional and nullable; untyped values remain unknown.
export interface LiquidAdditionalCheckoutButtons {

}

export interface LiquidAddress {
  "company"?: string | null;
  "phone"?: string | null;
  "first_name"?: string | null;
  "last_name"?: string | null;
  "name"?: string | null;
  "url"?: string | null;
  "summary"?: string | null;
  "id"?: number | null;
  "address1"?: string | null;
  "address2"?: string | null;
  "city"?: string | null;
  "zip"?: string | null;
  "country_code"?: string | null;
  "province_code"?: string | null;
  "country"?: LiquidCountry | null;
  "street"?: string | null;
  "province"?: string | null;
}

export interface LiquidAllCountryOptionTags {

}

export interface LiquidAllProducts {

}

export interface LiquidApp {
  "metafields"?: LiquidMetafields | null;
}

export interface LiquidArticle {
  "image"?: LiquidImage | null;
  "author"?: string | null;
  "metafields"?: LiquidMetafields | null;
  "handle"?: string | null;
  "id"?: string | null;
  "title"?: string | null;
  "url"?: string | null;
  "template_suffix"?: string | null;
  "created_at"?: string | null;
  "published_at"?: string | null;
  "updated_at"?: string | null;
  "moderated?"?: boolean | null;
  "comments"?: ReadonlyArray<LiquidComment> | null;
  "comments_count"?: number | null;
  "comments_enabled?"?: boolean | null;
  "comment_post_url"?: string | null;
  "content"?: string | null;
  "excerpt"?: string | null;
  "excerpt_or_content"?: string | null;
  "tags"?: ReadonlyArray<string> | null;
  "user"?: LiquidUser | null;
}

export interface LiquidArticles {

}

export interface LiquidBlock {
  "id"?: string | null;
  "settings"?: unknown | null;
  "type"?: string | null;
  "shopify_attributes"?: string | null;
}

export interface LiquidBlog {
  "id"?: number | null;
  "title"?: string | null;
  "handle"?: string | null;
  "articles"?: ReadonlyArray<LiquidArticle> | null;
  "articles_count"?: number | null;
  "metafields"?: LiquidMetafields | null;
  "url"?: string | null;
  "template_suffix"?: string | null;
  "all_tags"?: ReadonlyArray<string> | null;
  "tags"?: ReadonlyArray<string> | null;
  "comments_enabled?"?: boolean | null;
  "moderated?"?: boolean | null;
  "next_article"?: LiquidArticle | null;
  "previous_article"?: LiquidArticle | null;
}

export interface LiquidBlogs {

}

export interface LiquidBrand {
  "slogan"?: string | null;
  "short_description"?: string | null;
  "favicon_url"?: LiquidImage | null;
  "cover_image"?: LiquidImage | null;
  "logo"?: LiquidImage | null;
  "square_logo"?: LiquidImage | null;
  "colors"?: LiquidBrandColors | null;
  "metafields"?: LiquidMetafields | null;
}

export interface LiquidBrandColor {

}

export interface LiquidBrandColors {
  "primary"?: ReadonlyArray<LiquidBrandColor> | null;
  "secondary"?: ReadonlyArray<LiquidBrandColor> | null;
}

export interface LiquidCanonicalUrl {

}

export interface LiquidCart {
  "requires_shipping"?: boolean | null;
  "note"?: string | null;
  "item_count"?: number | null;
  "total_price"?: number | null;
  "checkout_charge_amount"?: number | null;
  "original_total_price"?: number | null;
  "items_subtotal_price"?: number | null;
  "total_discount"?: number | null;
  "items"?: ReadonlyArray<LiquidLineItem> | null;
  "empty?"?: boolean | null;
  "currency"?: LiquidCurrency | null;
  "total_weight"?: number | null;
  "discount_applications"?: ReadonlyArray<LiquidDiscountApplication> | null;
  "attributes"?: unknown | null;
  "cart_level_discount_applications"?: ReadonlyArray<LiquidDiscountApplication> | null;
  "discounts"?: ReadonlyArray<LiquidDiscount> | null;
  "taxes_included"?: boolean | null;
  "duties_included"?: boolean | null;
}

export interface LiquidCheckout {
  "applied_gift_cards"?: ReadonlyArray<LiquidGiftCard> | null;
  "attributes"?: unknown | null;
  "billing_address"?: LiquidAddress | null;
  "buyer_accepts_marketing"?: boolean | null;
  "cancelled"?: boolean | null;
  "cart_level_discount_applications"?: ReadonlyArray<LiquidDiscountApplication> | null;
  "currency"?: string | null;
  "customer"?: LiquidCustomer | null;
  "discount"?: LiquidDiscount | null;
  "discounts"?: ReadonlyArray<LiquidDiscount> | null;
  "discount_applications"?: ReadonlyArray<LiquidDiscountApplication> | null;
  "discounts_amount"?: ReadonlyArray<LiquidDiscountApplication> | null;
  "discounts_savings"?: ReadonlyArray<LiquidDiscountApplication> | null;
  "email"?: string | null;
  "financial_status"?: string | null;
  "fulfilled_at"?: string | null;
  "fulfilled_line_items"?: ReadonlyArray<LiquidLineItem> | null;
  "fulfillment_status"?: string | null;
  "gift_cards_amount"?: number | null;
  "id"?: number | null;
  "line_items"?: ReadonlyArray<LiquidLineItem> | null;
  "line_items_subtotal_price"?: number | null;
  "name"?: number | null;
  "note"?: string | null;
  "order"?: LiquidOrder | null;
  "order_id"?: string | null;
  "order_name"?: string | null;
  "order_number"?: string | null;
  "requires_shipping"?: boolean | null;
  "shipping_address"?: LiquidAddress | null;
  "shipping_method"?: LiquidShippingMethod | null;
  "shipping_price"?: number | null;
  "tax_lines"?: ReadonlyArray<LiquidTaxLine> | null;
  "tax_price"?: number | null;
  "total_price"?: number | null;
  "transactions"?: ReadonlyArray<LiquidTransaction> | null;
  "unavailable_line_items"?: ReadonlyArray<LiquidLineItem> | null;
  "unfulfilled_line_items"?: ReadonlyArray<LiquidLineItem> | null;
  "item_count"?: number | null;
}

export interface LiquidClosest {
  "product"?: LiquidProduct | null;
  "collection"?: LiquidCollection | null;
  "article"?: LiquidArticle | null;
  "blog"?: LiquidBlog | null;
  "page"?: LiquidPage | null;
  "metaobject"?: LiquidMetaobject | null;
}

export interface LiquidCollection {
  "metafields"?: LiquidMetafields | null;
  "id"?: number | null;
  "handle"?: string | null;
  "title"?: string | null;
  "description"?: string | null;
  "template_suffix"?: string | null;
  "current_vendor"?: string | null;
  "current_type"?: string | null;
  "url"?: string | null;
  "published_at"?: string | null;
  "image"?: LiquidImage | null;
  "sort_options"?: ReadonlyArray<LiquidSortOption> | null;
  "sort_by"?: string | null;
  "default_sort_by"?: string | null;
  "next_product"?: LiquidProduct | null;
  "previous_product"?: LiquidProduct | null;
  "products_count"?: number | null;
  "products"?: ReadonlyArray<LiquidProduct> | null;
  "all_products_count"?: number | null;
  "all_tags"?: ReadonlyArray<string> | null;
  "tags"?: ReadonlyArray<string> | null;
  "all_types"?: ReadonlyArray<string> | null;
  "all_vendors"?: ReadonlyArray<string> | null;
  "filters"?: ReadonlyArray<LiquidFilter> | null;
  "featured_image"?: LiquidImage | null;
}

export interface LiquidCollections {

}

export interface LiquidColor {
  "red"?: number | null;
  "green"?: number | null;
  "blue"?: number | null;
  "rgb"?: string | null;
  "rgba"?: string | null;
  "oklch"?: string | null;
  "oklcha"?: string | null;
  "hue"?: number | null;
  "saturation"?: number | null;
  "lightness"?: number | null;
  "alpha"?: number | null;
  "chroma"?: number | null;
  "color_space"?: string | null;
}

export interface LiquidColorScheme {
  "id"?: string | null;
  "settings"?: unknown | null;
}

export interface LiquidColorSchemeGroup {

}

export interface LiquidComment {
  "author"?: string | null;
  "content"?: string | null;
  "created_at"?: string | null;
  "email"?: string | null;
  "id"?: number | null;
  "status"?: string | null;
  "updated_at"?: string | null;
  "url"?: string | null;
}

export interface LiquidCompany {
  "id"?: number | null;
  "name"?: string | null;
  "external_id"?: string | null;
  "available_locations"?: ReadonlyArray<LiquidCompanyLocation> | null;
  "available_locations_count"?: number | null;
  "metafields"?: LiquidMetafields | null;
}

export interface LiquidCompanyAddress {
  "attention"?: string | null;
  "id"?: number | null;
  "address1"?: string | null;
  "address2"?: string | null;
  "first_name"?: string | null;
  "last_name"?: string | null;
  "city"?: string | null;
  "zip"?: string | null;
  "country_code"?: string | null;
  "province_code"?: string | null;
  "country"?: LiquidCountry | null;
  "street"?: string | null;
  "province"?: string | null;
}

export interface LiquidCompanyLocation {
  "id"?: number | null;
  "name"?: string | null;
  "external_id"?: string | null;
  "url_to_set_as_current"?: string | null;
  "current?"?: boolean | null;
  "company"?: LiquidCompany | null;
  "shipping_address"?: LiquidCompanyAddress | null;
  "tax_registration_id"?: number | null;
  "metafields"?: LiquidMetafields | null;
  "store_credit_account"?: LiquidStoreCreditAccount | null;
}

export interface LiquidContentForAdditionalCheckoutButtons {

}

export interface LiquidContentForHeader {

}

export interface LiquidContentForIndex {

}

export interface LiquidContentForLayout {

}

export interface LiquidCountry {
  "name"?: string | null;
  "iso_code"?: string | null;
  "unit_system"?: string | null;
  "currency"?: LiquidCurrency | null;
  "market"?: LiquidMarket | null;
  "popular?"?: boolean | null;
  "continent"?: string | null;
  "available_languages"?: ReadonlyArray<LiquidShopLocale> | null;
}

export interface LiquidCountryOptionTags {

}

export interface LiquidCurrency {
  "iso_code"?: string | null;
  "symbol"?: string | null;
  "name"?: string | null;
}

export interface LiquidCurrentPage {

}

export interface LiquidCurrentTags {

}

export interface LiquidCustomer {
  "first_name"?: string | null;
  "last_name"?: string | null;
  "orders_count"?: number | null;
  "total_spent"?: number | null;
  "orders"?: ReadonlyArray<LiquidOrder> | null;
  "last_order"?: LiquidOrder | null;
  "name"?: string | null;
  "email"?: string | null;
  "phone"?: string | null;
  "has_account"?: boolean | null;
  "accepts_marketing"?: boolean | null;
  "id"?: number | null;
  "metafields"?: LiquidMetafields | null;
  "tags"?: ReadonlyArray<string> | null;
  "default_address"?: LiquidAddress | null;
  "addresses"?: ReadonlyArray<LiquidAddress> | null;
  "addresses_count"?: number | null;
  "tax_exempt"?: boolean | null;
  "payment_methods"?: ReadonlyArray<LiquidCustomerPaymentMethod> | null;
  "b2b?"?: boolean | null;
  "company_available_locations"?: ReadonlyArray<LiquidCompanyLocation> | null;
  "company_available_locations_count"?: number | null;
  "current_location"?: LiquidCompanyLocation | null;
  "current_company"?: LiquidCompany | null;
  "has_avatar?"?: boolean | null;
  "store_credit_account"?: LiquidStoreCreditAccount | null;
}

export interface LiquidCustomerPaymentMethod {
  "payment_instrument_type"?: string | null;
  "token"?: string | null;
}

export interface LiquidDiscount {
  "amount"?: number | null;
  "total_amount"?: number | null;
  "code"?: string | null;
  "title"?: string | null;
  "type"?: string | null;
  "savings"?: number | null;
  "total_savings"?: number | null;
}

export interface LiquidDiscountAllocation {
  "discount_application"?: LiquidDiscountApplication | null;
  "amount"?: number | null;
}

export interface LiquidDiscountApplication {
  "total_allocated_amount"?: number | null;
  "title"?: string | null;
  "value"?: number | null;
  "target_selection"?: string | null;
  "type"?: string | null;
  "value_type"?: string | null;
  "target_type"?: string | null;
}

export interface LiquidExternalVideo {
  "external_id"?: string | null;
  "aspect_ratio"?: number | null;
  "host"?: string | null;
  "alt"?: string | null;
  "id"?: number | null;
  "media_type"?: string | null;
  "position"?: number | null;
  "preview_image"?: LiquidImage | null;
}

export interface LiquidFilter {
  "param_name"?: string | null;
  "label"?: string | null;
  "operator"?: string | null;
  "type"?: string | null;
  "active_values"?: ReadonlyArray<LiquidFilterValue> | null;
  "inactive_values"?: ReadonlyArray<LiquidFilterValue> | null;
  "values"?: ReadonlyArray<LiquidFilterValue> | null;
  "false_value"?: LiquidFilterValue | null;
  "true_value"?: LiquidFilterValue | null;
  "max_value"?: LiquidFilterValue | null;
  "min_value"?: LiquidFilterValue | null;
  "range_max"?: number | null;
  "url_to_remove"?: string | null;
  "presentation"?: string | null;
}

export interface LiquidFilterValue {
  "param_name"?: string | null;
  "value"?: string | null;
  "active"?: boolean | null;
  "count"?: number | null;
  "label"?: string | null;
  "url_to_add"?: string | null;
  "url_to_remove"?: string | null;
  "display"?: LiquidFilterValueDisplay | null;
  "swatch"?: LiquidSwatch | null;
  "image"?: LiquidImage | null;
}

export interface LiquidFilterValueDisplay {
  "type"?: string | null;
  "value"?: unknown | ReadonlyArray<LiquidColor> | LiquidImage | null;
}

export interface LiquidFocalPoint {
  "x"?: number | null;
  "y"?: number | null;
}

export interface LiquidFont {
  "family"?: string | null;
  "fallback_families"?: string | null;
  "baseline_ratio"?: number | null;
  "weight"?: number | null;
  "style"?: string | null;
  "variants"?: ReadonlyArray<LiquidFont> | null;
  "system?"?: boolean | null;
}

export interface LiquidForloop {
  "length"?: number | null;
  "parentloop"?: LiquidForloop | null;
  "index"?: number | null;
  "index0"?: number | null;
  "rindex"?: number | null;
  "rindex0"?: number | null;
  "first"?: boolean | null;
  "last"?: boolean | null;
}

export interface LiquidForm {
  "errors"?: LiquidFormErrors | null;
  "address1"?: string | null;
  "address2"?: string | null;
  "author"?: string | null;
  "body"?: string | null;
  "city"?: string | null;
  "company"?: string | null;
  "country"?: string | null;
  "email"?: string | null;
  "first_name"?: string | null;
  "id"?: string | null;
  "last_name"?: string | null;
  "password_needed"?: boolean | null;
  "phone"?: string | null;
  "posted_successfully?"?: boolean | null;
  "province"?: string | null;
  "set_as_default_checkbox"?: string | null;
  "name"?: string | null;
  "message"?: string | null;
  "zip"?: string | null;
}

export interface LiquidFormErrors {
  "messages"?: ReadonlyArray<string> | null;
  "translated_fields"?: ReadonlyArray<string> | null;
}

export interface LiquidFulfillment {
  "created_at"?: string | null;
  "item_count"?: number | null;
  "fulfillment_line_items"?: ReadonlyArray<LiquidLineItem> | null;
  "tracking_company"?: string | null;
  "tracking_numbers"?: ReadonlyArray<string> | null;
  "tracking_number"?: string | null;
  "tracking_url"?: string | null;
}

export interface LiquidGenericFile {
  "url"?: string | null;
  "id"?: number | null;
  "media_type"?: string | null;
  "preview_image"?: LiquidImage | null;
  "position"?: number | null;
  "alt"?: string | null;
}

export interface LiquidGiftCard {
  "balance"?: number | null;
  "code"?: string | null;
  "currency"?: string | null;
  "customer"?: LiquidCustomer | null;
  "recipient"?: LiquidRecipient | null;
  "message"?: string | null;
  "send_on"?: string | null;
  "enabled"?: boolean | null;
  "expired"?: boolean | null;
  "expires_on"?: string | null;
  "initial_value"?: number | null;
  "url"?: string | null;
  "template_suffix"?: string | null;
  "properties"?: ReadonlyArray<unknown> | null;
  "qr_identifier"?: string | null;
  "pass_url"?: string | null;
  "product"?: LiquidProduct | null;
  "variant"?: LiquidVariant | null;
  "last_four_characters"?: string | null;
}

export interface LiquidGroup {
  "user_agent"?: LiquidUserAgent | null;
  "rules"?: ReadonlyArray<LiquidRule> | null;
  "sitemap"?: LiquidSitemap | null;
}

export interface LiquidHandle {

}

export interface LiquidImage {
  "presentation"?: LiquidImagePresentation | null;
  "src"?: string | null;
  "width"?: number | null;
  "height"?: number | null;
  "aspect_ratio"?: number | null;
  "alt"?: string | null;
  "attached_to_variant?"?: boolean | null;
  "id"?: number | null;
  "media_type"?: string | null;
  "position"?: number | null;
  "preview_image"?: LiquidImage | null;
  "product_id"?: number | null;
  "variants"?: ReadonlyArray<LiquidVariant> | null;
}

export interface LiquidImagePresentation {
  "focal_point"?: LiquidFocalPoint | null;
}

export interface LiquidImages {

}

export interface LiquidInstructions {
  "can_remove"?: boolean | null;
  "can_update_quantity"?: boolean | null;
}

export interface LiquidLineItem {
  "id"?: number | null;
  "quantity"?: number | null;
  "price"?: number | null;
  "line_price"?: number | null;
  "total_discount"?: number | null;
  "discount_allocations"?: ReadonlyArray<LiquidDiscountAllocation> | null;
  "final_price"?: number | null;
  "final_line_price"?: number | null;
  "variant_id"?: number | null;
  "product_id"?: number | null;
  "product"?: LiquidProduct | null;
  "variant"?: LiquidVariant | null;
  "tax_lines"?: ReadonlyArray<LiquidTaxLine> | null;
  "fulfillment"?: LiquidFulfillment | null;
  "successfully_fulfilled_quantity"?: number | null;
  "fulfillment_service"?: string | null;
  "properties"?: ReadonlyArray<unknown> | null;
  "unit_price_measurement"?: LiquidUnitPriceMeasurement | null;
  "unit_price"?: number | null;
  "sku"?: string | null;
  "message"?: string | null;
  "vendor"?: string | null;
  "title"?: string | null;
  "taxable"?: boolean | null;
  "original_price"?: number | null;
  "original_line_price"?: number | null;
  "line_level_total_discount"?: number | null;
  "line_level_discount_allocations"?: ReadonlyArray<LiquidDiscountAllocation> | null;
  "discounts"?: ReadonlyArray<LiquidDiscount> | null;
  "gift_card"?: boolean | null;
  "requires_shipping"?: boolean | null;
  "options_with_values"?: ReadonlyArray<LiquidOptionWithValue> | null;
  "key"?: string | null;
  "grams"?: number | null;
  "url"?: string | null;
  "url_to_remove"?: string | null;
  "image"?: LiquidImage | null;
  "selling_plan_allocation"?: LiquidSellingPlanAllocation | null;
  "item_components"?: ReadonlyArray<LiquidLineItem> | null;
  "instructions"?: LiquidInstructions | null;
  "parent_relationship"?: LiquidParentRelationship | null;
  "error_message"?: string | null;
}

export interface LiquidLink {
  "active"?: boolean | null;
  "current"?: boolean | null;
  "child_active"?: boolean | null;
  "child_current"?: boolean | null;
  "handle"?: string | null;
  "links"?: ReadonlyArray<LiquidLink> | null;
  "object"?: unknown | LiquidArticle | LiquidBlog | LiquidCollection | LiquidMetaobject | LiquidPage | LiquidPolicy | LiquidProduct | null;
  "title"?: string | null;
  "data_sharing_opt_out_icon"?: string | null;
  "type"?: string | null;
  "levels"?: number | null;
  "url"?: string | null;
}

export interface LiquidLinklist {
  "links"?: ReadonlyArray<LiquidLink> | null;
  "handle"?: string | null;
  "levels"?: number | null;
  "title"?: string | null;
}

export interface LiquidLinklists {

}

export interface LiquidLocalization {
  "available_countries"?: ReadonlyArray<LiquidCountry> | null;
  "available_languages"?: ReadonlyArray<LiquidShopLocale> | null;
  "market"?: LiquidMarket | null;
  "country"?: LiquidCountry | null;
  "language"?: LiquidShopLocale | null;
}

export interface LiquidLocation {
  "id"?: number | null;
  "name"?: string | null;
  "address"?: LiquidAddress | null;
  "latitude"?: number | null;
  "longitude"?: number | null;
  "metafields"?: LiquidMetafields | null;
}

export interface LiquidMarket {
  "id"?: string | null;
  "handle"?: string | null;
  "metafields"?: LiquidMetafields | null;
}

export interface LiquidMeasurement {
  "type"?: string | null;
  "value"?: number | null;
  "unit"?: string | null;
}

export interface LiquidMedia {
  "id"?: number | null;
  "position"?: number | null;
  "media_type"?: string | null;
  "preview_image"?: LiquidImage | null;
  "alt"?: string | null;
}

export interface LiquidMetafield {
  "value"?: unknown | null;
  "type"?: string | null;
  "list?"?: boolean | null;
}

export interface LiquidMetafieldNamespace {

}

export interface LiquidMetafields {

}

export interface LiquidMetaobject {
  "system"?: LiquidMetaobjectSystem | null;
}

export interface LiquidMetaobjectDefinition {
  "values"?: ReadonlyArray<LiquidMetaobject> | null;
  "values_count"?: number | null;
}

export interface LiquidMetaobjectSystem {
  "type"?: string | null;
  "handle"?: string | null;
  "id"?: number | null;
  "url"?: string | null;
  "template_suffix"?: string | null;
}

export interface LiquidMetaobjects {

}

export interface LiquidModel {
  "sources"?: ReadonlyArray<LiquidModelSource> | null;
  "alt"?: string | null;
  "id"?: number | null;
  "media_type"?: string | null;
  "position"?: number | null;
  "preview_image"?: LiquidImage | null;
}

export interface LiquidModelSource {
  "format"?: string | null;
  "mime_type"?: string | null;
  "url"?: string | null;
}

export interface LiquidMoney {
  "currency"?: LiquidCurrency | null;
}

export interface LiquidOptionWithValue {
  "name"?: string | null;
  "value"?: LiquidProductOptionValue | null;
}

export interface LiquidOrder {
  "discounts"?: LiquidDiscount | null;
  "attributes"?: unknown | null;
  "cancel_reason"?: string | null;
  "cancel_reason_label"?: string | null;
  "cancelled"?: boolean | null;
  "cancelled_at"?: string | null;
  "cart_level_discount_applications"?: ReadonlyArray<LiquidDiscountApplication> | null;
  "created_at"?: string | null;
  "total_duties"?: number | null;
  "customer_url"?: string | null;
  "customer"?: LiquidCustomer | null;
  "discount_applications"?: ReadonlyArray<LiquidDiscountApplication> | null;
  "total_discounts"?: number | null;
  "total_net_amount"?: number | null;
  "tax_price"?: number | null;
  "total_refunded_amount"?: number | null;
  "email"?: string | null;
  "financial_status"?: string | null;
  "financial_status_label"?: string | null;
  "fulfillment_status"?: string | null;
  "fulfillment_status_label"?: string | null;
  "id"?: number | null;
  "metafields"?: LiquidMetafields | null;
  "name"?: string | null;
  "note"?: string | null;
  "confirmation_number"?: string | null;
  "order_number"?: number | null;
  "order_status_url"?: string | null;
  "customer_order_url"?: string | null;
  "phone"?: string | null;
  "shipping_address"?: LiquidAddress | null;
  "billing_address"?: LiquidAddress | null;
  "tags"?: ReadonlyArray<string> | null;
  "tax_lines"?: ReadonlyArray<LiquidTaxLine> | null;
  "transactions"?: ReadonlyArray<LiquidTransaction> | null;
  "line_items"?: ReadonlyArray<LiquidLineItem> | null;
  "subtotal_line_items"?: ReadonlyArray<LiquidLineItem> | null;
  "item_count"?: number | null;
  "shipping_methods"?: ReadonlyArray<LiquidShippingMethod> | null;
  "line_items_subtotal_price"?: number | null;
  "subtotal_price"?: number | null;
  "total_price"?: number | null;
  "shipping_price"?: number | null;
  "pickup_in_store?"?: boolean | null;
}

export interface LiquidPage {
  "id"?: number | null;
  "author"?: string | null;
  "handle"?: string | null;
  "title"?: string | null;
  "template_suffix"?: string | null;
  "content"?: string | null;
  "url"?: string | null;
  "metafields"?: LiquidMetafields | null;
  "published_at"?: string | null;
}

export interface LiquidPageDescription {

}

export interface LiquidPageImage {

}

export interface LiquidPageTitle {

}

export interface LiquidPages {

}

export interface LiquidPaginate {
  "page_size"?: number | null;
  "current_offset"?: number | null;
  "current_page"?: number | null;
  "items"?: number | null;
  "parts"?: ReadonlyArray<LiquidPart> | null;
  "next"?: LiquidPart | null;
  "previous"?: LiquidPart | null;
  "pages"?: number | null;
  "page_param"?: string | null;
}

export interface LiquidParentRelationship {
  "parent"?: LiquidLineItem | null;
}

export interface LiquidPart {
  "is_link"?: boolean | null;
  "title"?: string | null;
  "url"?: string | null;
}

export interface LiquidPendingPaymentInstructionInput {
  "header"?: string | null;
  "value"?: string | null;
}

export interface LiquidPolicy {
  "id"?: string | null;
  "body"?: string | null;
  "url"?: string | null;
  "title"?: string | null;
}

export interface LiquidPoweredByLink {

}

export interface LiquidPredictiveSearch {
  "performed"?: boolean | null;
  "resources"?: LiquidPredictiveSearchResources | null;
  "terms"?: string | null;
  "types"?: ReadonlyArray<string> | null;
}

export interface LiquidPredictiveSearchResources {
  "articles"?: ReadonlyArray<LiquidArticle> | null;
  "collections"?: ReadonlyArray<LiquidCollection> | null;
  "pages"?: ReadonlyArray<LiquidPage> | null;
  "products"?: ReadonlyArray<LiquidProduct> | null;
}

export interface LiquidProduct {
  "selling_plan_groups"?: ReadonlyArray<LiquidSellingPlanGroup> | null;
  "metafields"?: LiquidMetafields | null;
  "options_with_values"?: ReadonlyArray<LiquidProductOption> | null;
  "category"?: LiquidTaxonomyCategory | null;
  "variants"?: ReadonlyArray<LiquidVariant> | null;
  "variants_count"?: number | null;
  "id"?: number | null;
  "title"?: string | null;
  "handle"?: string | null;
  "template_suffix"?: string | null;
  "vendor"?: string | null;
  "description"?: string | null;
  "content"?: string | null;
  "featured_image"?: LiquidImage | null;
  "featured_media"?: LiquidMedia | null;
  "media"?: ReadonlyArray<LiquidMedia> | null;
  "images"?: ReadonlyArray<LiquidImage> | null;
  "price_min"?: number | null;
  "price"?: number | null;
  "price_max"?: number | null;
  "price_varies"?: boolean | null;
  "selected_or_first_available_variant"?: LiquidVariant | null;
  "collections"?: ReadonlyArray<LiquidCollection> | null;
  "selected_variant"?: LiquidVariant | null;
  "first_available_variant"?: LiquidVariant | null;
  "available"?: boolean | null;
  "options"?: ReadonlyArray<string> | null;
  "type"?: string | null;
  "compare_at_price_min"?: number | null;
  "compare_at_price_max"?: number | null;
  "compare_at_price"?: number | null;
  "compare_at_price_varies"?: boolean | null;
  "url"?: string | null;
  "tags"?: ReadonlyArray<string> | null;
  "published_at"?: string | null;
  "created_at"?: string | null;
  "options_by_name"?: unknown | null;
  "has_only_default_variant"?: boolean | null;
  "quantity_price_breaks_configured?"?: boolean | null;
  "requires_selling_plan"?: boolean | null;
  "selected_selling_plan"?: LiquidSellingPlan | null;
  "selected_selling_plan_allocation"?: LiquidSellingPlanAllocation | null;
  "selected_or_first_available_selling_plan_allocation"?: LiquidSellingPlanAllocation | null;
  "gift_card?"?: boolean | null;
}

export interface LiquidProductOption {
  "name"?: string | null;
  "position"?: number | null;
  "values"?: ReadonlyArray<LiquidProductOptionValue> | null;
  "selected_value"?: string | null;
}

export interface LiquidProductOptionValue {
  "id"?: number | null;
  "name"?: string | null;
  "swatch"?: LiquidSwatch | null;
  "selected"?: boolean | null;
  "available"?: boolean | null;
  "variant"?: LiquidVariant | null;
  "product_url"?: string | null;
}

export interface LiquidQuantityPriceBreak {
  "minimum_quantity"?: number | null;
  "price"?: number | null;
}

export interface LiquidQuantityRule {
  "min"?: number | null;
  "max"?: number | null;
  "increment"?: number | null;
}

export interface LiquidRating {
  "rating"?: number | null;
  "scale_min"?: number | null;
  "scale_max"?: number | null;
}

export interface LiquidRecipient {
  "nickname"?: string | null;
  "email"?: string | null;
  "name"?: string | null;
}

export interface LiquidRecommendations {
  "performed?"?: boolean | null;
  "products"?: ReadonlyArray<LiquidProduct> | null;
  "products_count"?: number | null;
  "intent"?: string | null;
}

export interface LiquidRemoteDetails {
  "type"?: string | null;
  "shop"?: LiquidRemoteShop | null;
}

export interface LiquidRemoteProduct {
  "title"?: string | null;
  "remote_details"?: LiquidRemoteDetails | null;
  "featured_media"?: LiquidMedia | null;
  "media"?: ReadonlyArray<LiquidMedia> | null;
  "images"?: ReadonlyArray<LiquidImage> | null;
  "template_suffix"?: string | null;
  "metafields"?: LiquidMetafields | null;
  "description"?: string | null;
  "content"?: string | null;
  "selling_plan_groups"?: ReadonlyArray<LiquidSellingPlanGroup> | null;
  "options_with_values"?: ReadonlyArray<LiquidProductOption> | null;
  "category"?: LiquidTaxonomyCategory | null;
  "variants"?: ReadonlyArray<LiquidVariant> | null;
  "variants_count"?: number | null;
  "id"?: number | null;
  "vendor"?: string | null;
  "featured_image"?: LiquidImage | null;
  "price_min"?: number | null;
  "price"?: number | null;
  "price_max"?: number | null;
  "price_varies"?: boolean | null;
  "selected_or_first_available_variant"?: LiquidVariant | null;
  "selected_variant"?: LiquidVariant | null;
  "first_available_variant"?: LiquidVariant | null;
  "available"?: boolean | null;
  "options"?: ReadonlyArray<string> | null;
  "type"?: string | null;
  "compare_at_price_min"?: number | null;
  "compare_at_price_max"?: number | null;
  "compare_at_price"?: number | null;
  "compare_at_price_varies"?: boolean | null;
  "url"?: string | null;
  "published_at"?: string | null;
  "created_at"?: string | null;
  "options_by_name"?: unknown | null;
  "has_only_default_variant"?: boolean | null;
  "quantity_price_breaks_configured?"?: boolean | null;
  "requires_selling_plan"?: boolean | null;
  "selected_selling_plan"?: LiquidSellingPlan | null;
  "selected_selling_plan_allocation"?: LiquidSellingPlanAllocation | null;
  "selected_or_first_available_selling_plan_allocation"?: LiquidSellingPlanAllocation | null;
  "gift_card?"?: boolean | null;
}

export interface LiquidRemoteShop {
  "name"?: string | null;
  "brand"?: LiquidBrand | null;
  "shipping_policy"?: LiquidPolicy | null;
  "refund_policy"?: LiquidPolicy | null;
  "policies"?: ReadonlyArray<LiquidPolicy> | null;
}

export interface LiquidRequest {
  "design_mode"?: boolean | null;
  "visual_preview_mode"?: boolean | null;
  "page_type"?: string | null;
  "host"?: string | null;
  "origin"?: string | null;
  "path"?: string | null;
  "locale"?: LiquidShopLocale | null;
}

export interface LiquidRobots {
  "default_groups"?: ReadonlyArray<LiquidGroup> | null;
}

export interface LiquidRoutes {
  "root_url"?: string | null;
  "account_url"?: string | null;
  "account_login_url"?: string | null;
  "account_logout_url"?: string | null;
  "account_recover_url"?: string | null;
  "account_register_url"?: string | null;
  "account_addresses_url"?: string | null;
  "account_profile_url"?: string | null;
  "collections_url"?: string | null;
  "all_products_collection_url"?: string | null;
  "search_url"?: string | null;
  "predictive_search_url"?: string | null;
  "cart_url"?: string | null;
  "cart_add_url"?: string | null;
  "cart_change_url"?: string | null;
  "cart_clear_url"?: string | null;
  "cart_update_url"?: string | null;
  "product_recommendations_url"?: string | null;
  "storefront_login_url"?: string | null;
}

export interface LiquidRule {
  "directive"?: string | null;
  "value"?: string | null;
}

export interface LiquidScript {
  "id"?: number | null;
  "name"?: string | null;
}

export interface LiquidScripts {
  "cart_calculate_line_items"?: LiquidScript | null;
}

export interface LiquidSearch {
  "terms"?: string | null;
  "filters"?: ReadonlyArray<LiquidFilter> | null;
  "performed"?: boolean | null;
  "results"?: unknown | ReadonlyArray<LiquidArticle | LiquidPage | LiquidProduct> | null;
  "results_count"?: number | null;
  "sort_options"?: ReadonlyArray<LiquidSortOption> | null;
  "sort_by"?: string | null;
  "default_sort_by"?: string | null;
  "types"?: ReadonlyArray<string> | null;
}

export interface LiquidSection {
  "id"?: string | null;
  "settings"?: unknown | null;
  "index"?: number | null;
  "index0"?: number | null;
  "location"?: string | null;
  "blocks"?: ReadonlyArray<LiquidBlock> | null;
}

export interface LiquidSelf {

}

export interface LiquidSellingPlan {
  "id"?: number | null;
  "name"?: string | null;
  "description"?: string | null;
  "group_id"?: string | null;
  "recurring_deliveries"?: boolean | null;
  "options"?: ReadonlyArray<LiquidSellingPlanOption> | null;
  "price_adjustments"?: ReadonlyArray<LiquidSellingPlanPriceAdjustment> | null;
  "selected"?: boolean | null;
  "checkout_charge"?: LiquidSellingPlanCheckoutCharge | null;
}

export interface LiquidSellingPlanAllocation {
  "price"?: number | null;
  "compare_at_price"?: number | null;
  "price_adjustments"?: ReadonlyArray<LiquidSellingPlanAllocationPriceAdjustment> | null;
  "unit_price"?: number | null;
  "per_delivery_price"?: number | null;
  "selling_plan"?: LiquidSellingPlan | null;
  "selling_plan_group_id"?: string | null;
  "checkout_charge_amount"?: number | null;
  "remaining_balance_charge_amount"?: number | null;
}

export interface LiquidSellingPlanAllocationPriceAdjustment {
  "position"?: number | null;
  "price"?: number | null;
}

export interface LiquidSellingPlanCheckoutCharge {
  "value_type"?: string | null;
  "value"?: number | null;
}

export interface LiquidSellingPlanGroup {
  "selling_plans"?: ReadonlyArray<LiquidSellingPlan> | null;
  "id"?: number | null;
  "name"?: string | null;
  "app_id"?: string | null;
  "options"?: ReadonlyArray<LiquidSellingPlanGroupOption> | null;
  "selling_plan_selected"?: boolean | null;
}

export interface LiquidSellingPlanGroupOption {
  "name"?: string | null;
  "position"?: number | null;
  "values"?: ReadonlyArray<string> | null;
  "selected_value"?: string | null;
}

export interface LiquidSellingPlanOption {
  "name"?: string | null;
  "position"?: number | null;
  "value"?: string | null;
}

export interface LiquidSellingPlanPriceAdjustment {
  "order_count"?: number | null;
  "position"?: number | null;
  "value_type"?: string | null;
  "value"?: number | null;
}

export interface LiquidSettings {

}

export interface LiquidShippingMethod {
  "title"?: string | null;
  "original_price"?: number | null;
  "price_with_discounts"?: number | null;
  "price"?: number | null;
  "handle"?: string | null;
  "id"?: string | null;
  "tax_lines"?: ReadonlyArray<LiquidTaxLine> | null;
  "discount_allocations"?: ReadonlyArray<LiquidDiscountAllocation> | null;
}

export interface LiquidShop {
  "id"?: string | null;
  "name"?: string | null;
  "description"?: string | null;
  "enabled_currencies"?: ReadonlyArray<LiquidCurrency> | null;
  "published_locales"?: ReadonlyArray<LiquidShopLocale> | null;
  "enabled_locales"?: ReadonlyArray<LiquidShopLocale> | null;
  "locale"?: LiquidShopLocale | null;
  "url"?: string | null;
  "email"?: string | null;
  "secure_url"?: string | null;
  "domain"?: string | null;
  "permanent_domain"?: string | null;
  "phone"?: string | null;
  "password_message"?: string | null;
  "address"?: LiquidAddress | null;
  "customer_accounts_enabled"?: boolean | null;
  "customer_accounts_optional"?: boolean | null;
  "currency"?: string | null;
  "money_format"?: LiquidCurrency | null;
  "money_with_currency_format"?: LiquidCurrency | null;
  "metafields"?: LiquidMetafields | null;
  "enabled_payment_types"?: ReadonlyArray<string> | null;
  "taxes_included"?: boolean | null;
  "refund_policy"?: LiquidPolicy | null;
  "shipping_policy"?: LiquidPolicy | null;
  "privacy_policy"?: LiquidPolicy | null;
  "terms_of_service"?: LiquidPolicy | null;
  "subscription_policy"?: LiquidPolicy | null;
  "policies"?: ReadonlyArray<LiquidPolicy> | null;
  "vendors"?: ReadonlyArray<string> | null;
  "types"?: ReadonlyArray<string> | null;
  "search_types"?: ReadonlyArray<string> | null;
  "products_count"?: number | null;
  "collections_count"?: number | null;
  "accepts_gift_cards"?: boolean | null;
  "brand"?: LiquidBrand | null;
  "metaobjects"?: LiquidMetaobjects | null;
}

export interface LiquidShopLocale {
  "name"?: string | null;
  "endonym_name"?: string | null;
  "iso_code"?: string | null;
  "primary"?: boolean | null;
  "direction"?: string | null;
  "root_url"?: string | null;
}

export interface LiquidSitemap {
  "directive"?: string | null;
  "value"?: string | null;
}

export interface LiquidSortOption {
  "name"?: string | null;
  "value"?: string | null;
}

export interface LiquidStoreAvailability {
  "available"?: boolean | null;
  "pick_up_enabled"?: boolean | null;
  "physical_storefront"?: boolean | null;
  "pick_up_time"?: string | null;
  "location"?: LiquidLocation | null;
}

export interface LiquidStoreCreditAccount {
  "balance"?: LiquidMoney | null;
}

export interface LiquidSwatch {
  "color"?: LiquidColor | null;
  "image"?: LiquidImage | null;
}

export interface LiquidTablerowloop {
  "length"?: number | null;
  "col"?: number | null;
  "row"?: number | null;
  "index"?: number | null;
  "index0"?: number | null;
  "col0"?: number | null;
  "rindex"?: number | null;
  "rindex0"?: number | null;
  "first"?: boolean | null;
  "last"?: boolean | null;
  "col_first"?: boolean | null;
  "col_last"?: boolean | null;
}

export interface LiquidTaxLine {
  "title"?: string | null;
  "price"?: number | null;
  "rate"?: number | null;
  "rate_percentage"?: number | null;
}

export interface LiquidTaxonomyCategory {
  "gid"?: string | null;
  "id"?: string | null;
  "name"?: string | null;
  "ancestors"?: ReadonlyArray<LiquidTaxonomyCategory> | null;
}

export interface LiquidTemplate {
  "name"?: string | null;
  "suffix"?: string | null;
  "directory"?: string | null;
}

export interface LiquidTheme {
  "id"?: number | null;
  "name"?: string | null;
  "role"?: string | null;
}

export interface LiquidTransaction {
  "id"?: number | null;
  "name"?: string | null;
  "status"?: string | null;
  "created_at"?: string | null;
  "receipt"?: string | null;
  "kind"?: string | null;
  "gateway"?: string | null;
  "status_label"?: string | null;
  "payment_details"?: LiquidTransactionPaymentDetails | null;
  "amount"?: number | null;
  "gateway_display_name"?: string | null;
  "show_buyer_pending_payment_instructions?"?: boolean | null;
  "buyer_pending_payment_notice"?: string | null;
  "buyer_pending_payment_instructions"?: ReadonlyArray<LiquidPendingPaymentInstructionInput> | null;
}

export interface LiquidTransactionPaymentDetails {
  "credit_card_company"?: string | null;
  "credit_card_last_four_digits"?: string | null;
  "credit_card_number"?: string | null;
  "gift_card"?: LiquidGiftCard | null;
}

export interface LiquidUnitPriceMeasurement {
  "measured_type"?: string | null;
  "quantity_value"?: number | null;
  "quantity_unit"?: string | null;
  "reference_value"?: number | null;
  "reference_unit"?: string | null;
}

export interface LiquidUser {
  "account_owner"?: boolean | null;
  "bio"?: string | null;
  "email"?: string | null;
  "first_name"?: string | null;
  "homepage"?: string | null;
  "image"?: LiquidImage | null;
  "last_name"?: string | null;
  "name"?: string | null;
}

export interface LiquidUserAgent {
  "directive"?: string | null;
  "value"?: string | null;
}

export interface LiquidVariant {
  "metafields"?: LiquidMetafields | null;
  "product"?: LiquidProduct | null;
  "selected"?: boolean | null;
  "matched"?: boolean | null;
  "id"?: number | null;
  "title"?: string | null;
  "quantity_rule"?: LiquidQuantityRule | null;
  "quantity_price_breaks"?: ReadonlyArray<LiquidQuantityPriceBreak> | null;
  "quantity_price_breaks_configured?"?: boolean | null;
  "price"?: number | null;
  "compare_at_price"?: number | null;
  "selected_selling_plan_allocation"?: LiquidSellingPlanAllocation | null;
  "selling_plan_allocations"?: ReadonlyArray<LiquidSellingPlanAllocation> | null;
  "sku"?: string | null;
  "barcode"?: string | null;
  "available"?: boolean | null;
  "options"?: LiquidProductOptionValue | null;
  "options_with_values"?: ReadonlyArray<LiquidOptionWithValue> | null;
  "option1"?: string | null;
  "option2"?: string | null;
  "option3"?: string | null;
  "url"?: string | null;
  "weight_unit"?: string | null;
  "weight_in_unit"?: number | null;
  "weight"?: number | null;
  "unit_price_measurement"?: LiquidUnitPriceMeasurement | null;
  "unit_price"?: number | null;
  "inventory_quantity"?: number | null;
  "inventory_management"?: string | null;
  "inventory_policy"?: string | null;
  "requires_shipping"?: boolean | null;
  "taxable"?: boolean | null;
  "featured_image"?: LiquidImage | null;
  "image"?: LiquidImage | null;
  "featured_media"?: LiquidMedia | null;
  "incoming"?: boolean | null;
  "next_incoming_date"?: string | null;
  "store_availabilities"?: ReadonlyArray<LiquidStoreAvailability> | null;
  "requires_selling_plan"?: boolean | null;
}

export interface LiquidVideo {
  "sources"?: ReadonlyArray<LiquidVideoSource> | null;
  "duration"?: number | null;
  "aspect_ratio"?: number | null;
  "alt"?: string | null;
  "id"?: number | null;
  "media_type"?: string | null;
  "position"?: number | null;
  "preview_image"?: LiquidImage | null;
}

export interface LiquidVideoSource {
  "width"?: number | null;
  "format"?: string | null;
  "height"?: number | null;
  "mime_type"?: string | null;
  "url"?: string | null;
}

export interface LiquidObjectMap {
  "additional_checkout_buttons": LiquidAdditionalCheckoutButtons;
  "address": LiquidAddress;
  "all_country_option_tags": LiquidAllCountryOptionTags;
  "all_products": LiquidAllProducts;
  "app": LiquidApp;
  "article": LiquidArticle;
  "articles": LiquidArticles;
  "block": LiquidBlock;
  "blog": LiquidBlog;
  "blogs": LiquidBlogs;
  "brand": LiquidBrand;
  "brand_color": LiquidBrandColor;
  "brand_colors": LiquidBrandColors;
  "canonical_url": LiquidCanonicalUrl;
  "cart": LiquidCart;
  "checkout": LiquidCheckout;
  "closest": LiquidClosest;
  "collection": LiquidCollection;
  "collections": LiquidCollections;
  "color": LiquidColor;
  "color_scheme": LiquidColorScheme;
  "color_scheme_group": LiquidColorSchemeGroup;
  "comment": LiquidComment;
  "company": LiquidCompany;
  "company_address": LiquidCompanyAddress;
  "company_location": LiquidCompanyLocation;
  "content_for_additional_checkout_buttons": LiquidContentForAdditionalCheckoutButtons;
  "content_for_header": LiquidContentForHeader;
  "content_for_index": LiquidContentForIndex;
  "content_for_layout": LiquidContentForLayout;
  "country": LiquidCountry;
  "country_option_tags": LiquidCountryOptionTags;
  "currency": LiquidCurrency;
  "current_page": LiquidCurrentPage;
  "current_tags": LiquidCurrentTags;
  "customer": LiquidCustomer;
  "customer_payment_method": LiquidCustomerPaymentMethod;
  "discount": LiquidDiscount;
  "discount_allocation": LiquidDiscountAllocation;
  "discount_application": LiquidDiscountApplication;
  "external_video": LiquidExternalVideo;
  "filter": LiquidFilter;
  "filter_value": LiquidFilterValue;
  "filter_value_display": LiquidFilterValueDisplay;
  "focal_point": LiquidFocalPoint;
  "font": LiquidFont;
  "forloop": LiquidForloop;
  "form": LiquidForm;
  "form_errors": LiquidFormErrors;
  "fulfillment": LiquidFulfillment;
  "generic_file": LiquidGenericFile;
  "gift_card": LiquidGiftCard;
  "group": LiquidGroup;
  "handle": LiquidHandle;
  "image": LiquidImage;
  "image_presentation": LiquidImagePresentation;
  "images": LiquidImages;
  "instructions": LiquidInstructions;
  "line_item": LiquidLineItem;
  "link": LiquidLink;
  "linklist": LiquidLinklist;
  "linklists": LiquidLinklists;
  "localization": LiquidLocalization;
  "location": LiquidLocation;
  "market": LiquidMarket;
  "measurement": LiquidMeasurement;
  "media": LiquidMedia;
  "metafield": LiquidMetafield;
  "metafield_namespace": LiquidMetafieldNamespace;
  "metafields": LiquidMetafields;
  "metaobject": LiquidMetaobject;
  "metaobject_definition": LiquidMetaobjectDefinition;
  "metaobject_system": LiquidMetaobjectSystem;
  "metaobjects": LiquidMetaobjects;
  "model": LiquidModel;
  "model_source": LiquidModelSource;
  "money": LiquidMoney;
  "option_with_value": LiquidOptionWithValue;
  "order": LiquidOrder;
  "page": LiquidPage;
  "page_description": LiquidPageDescription;
  "page_image": LiquidPageImage;
  "page_title": LiquidPageTitle;
  "pages": LiquidPages;
  "paginate": LiquidPaginate;
  "parent_relationship": LiquidParentRelationship;
  "part": LiquidPart;
  "pending_payment_instruction_input": LiquidPendingPaymentInstructionInput;
  "policy": LiquidPolicy;
  "powered_by_link": LiquidPoweredByLink;
  "predictive_search": LiquidPredictiveSearch;
  "predictive_search_resources": LiquidPredictiveSearchResources;
  "product": LiquidProduct;
  "product_option": LiquidProductOption;
  "product_option_value": LiquidProductOptionValue;
  "quantity_price_break": LiquidQuantityPriceBreak;
  "quantity_rule": LiquidQuantityRule;
  "rating": LiquidRating;
  "recipient": LiquidRecipient;
  "recommendations": LiquidRecommendations;
  "remote_details": LiquidRemoteDetails;
  "remote_product": LiquidRemoteProduct;
  "remote_shop": LiquidRemoteShop;
  "request": LiquidRequest;
  "robots": LiquidRobots;
  "routes": LiquidRoutes;
  "rule": LiquidRule;
  "script": LiquidScript;
  "scripts": LiquidScripts;
  "search": LiquidSearch;
  "section": LiquidSection;
  "self": LiquidSelf;
  "selling_plan": LiquidSellingPlan;
  "selling_plan_allocation": LiquidSellingPlanAllocation;
  "selling_plan_allocation_price_adjustment": LiquidSellingPlanAllocationPriceAdjustment;
  "selling_plan_checkout_charge": LiquidSellingPlanCheckoutCharge;
  "selling_plan_group": LiquidSellingPlanGroup;
  "selling_plan_group_option": LiquidSellingPlanGroupOption;
  "selling_plan_option": LiquidSellingPlanOption;
  "selling_plan_price_adjustment": LiquidSellingPlanPriceAdjustment;
  "settings": LiquidSettings;
  "shipping_method": LiquidShippingMethod;
  "shop": LiquidShop;
  "shop_locale": LiquidShopLocale;
  "sitemap": LiquidSitemap;
  "sort_option": LiquidSortOption;
  "store_availability": LiquidStoreAvailability;
  "store_credit_account": LiquidStoreCreditAccount;
  "swatch": LiquidSwatch;
  "tablerowloop": LiquidTablerowloop;
  "tax_line": LiquidTaxLine;
  "taxonomy_category": LiquidTaxonomyCategory;
  "template": LiquidTemplate;
  "theme": LiquidTheme;
  "transaction": LiquidTransaction;
  "transaction_payment_details": LiquidTransactionPaymentDetails;
  "unit_price_measurement": LiquidUnitPriceMeasurement;
  "user": LiquidUser;
  "user_agent": LiquidUserAgent;
  "variant": LiquidVariant;
  "video": LiquidVideo;
  "video_source": LiquidVideoSource;
}
