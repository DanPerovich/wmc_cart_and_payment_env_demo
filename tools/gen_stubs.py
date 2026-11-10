#!/usr/bin/env python3
"""Generate stub-mappings.json for the Payments Demo API.

Usage: [TEST_CARDS_DATA_SOURCE_ID=<id>] gen_stubs.py <output-path>
"""
import json
import os
import sys

# Where the two webhook stubs deliver. Default: WireMock Cloud's free echo service (it replies with a
# copy of the request and stores nothing). Set WEBHOOK_URL for e.g. a webhook.site address.
WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "https://wc-echo.wiremockapi.cloud/webhook/echo")
# ID of the "Test Cards" CSV data source (.wiremock/payments-api/data-sources/test-cards.csv).
# A recreated data source gets a NEW id: set TEST_CARDS_DATA_SOURCE_ID to it before generating.
import os
CARDS_DS = os.environ.get("TEST_CARDS_DATA_SOURCE_ID", "xg9vr")

JSON_HDR = {"Content-Type": "application/json"}

# Fixed stub IDs (taken from the deployed mock API). Re-pushing the generated file then overwrites
# these stubs in place; without IDs every push would add a second copy of every stub.
STUB_IDS = {
    "Create payment (outcome driven by Test Cards data source)": "51c0ad03-cf56-4a9d-9c88-6c6a21386fef",
    "Create payment - unknown card token": "310ac933-36cd-45b0-a135-08d7749c5ac2",
    "Create refund (stateful, partial or full)": "ed632a4a-45f3-4cd0-85b3-9dad7f271d41",
    "Create refund - payment not refundable (declined)": "075c9cef-481c-4662-a9f2-71a9a02167a3",
    "Get payment status": "9e58ee46-fd7a-436a-9985-d2f5c1b954bf",
    "Get refund": "ac3911cb-a0a0-44c1-9e85-c4a9d0567070",
    "List refunds for payment": "8e3d1225-c823-4558-aeb3-c3034bd356b0",
    "Not found - create refund (payment missing)": "6bf897a8-64d4-4095-ab42-459f22a623a0",
    "Not found - get payment": "a652bde6-2a81-4ed2-af56-ade922bcff43",
    "Not found - get refund": "0d553256-47c8-4128-8db5-b0ef3ae77bed",
    "Not found - list refunds (payment missing)": "27acdf74-e80a-4cbc-8330-85a31d896c6e",
}


def op(operation, context, key=None, value=None):
    o = {"context": context, "operation": operation, "phase": "AFTER_MATCH"}
    if key is not None:
        o["key"] = key
    if value is not None:
        o["value"] = value
    return o


def var(key, value):
    return op("REQUEST_VAR", "local", key, value)


def change_state(*ops):
    return {"name": "change-state", "parameters": {"operations": list(ops)}}


def webhook(event_type_template, data_template):
    """Webhook parameters for `postServeActions: [{"name": "webhook", "parameters": ...}]`.

    WireMock Cloud's UI (and its stub schema) keep webhooks under postServeActions, not under
    serveEventListeners, so that is where they must go to show up in the stub editor."""
    body = (
        "{\n"
        '  "id": "evt_{{randomValue type=\'ALPHANUMERIC\' length=12 uppercase=false}}",\n'
        f'  "type": "{event_type_template}",\n'
        '  "createdAt": "{{now}}",\n'
        f'  "data": {data_template}\n'
        "}"
    )
    return {
        "method": "POST",
        "url": WEBHOOK_URL,
        "headers": {"Content-Type": "application/json"},
        "body": body,
    }


def require_absent(key_template, context):
    return {
        "name": "custom-and-matcher",
        "parameters": {
            "matchers": [
                {
                    "name": "require-state",
                    "parameters": {
                        "requirements": [
                            {"key": key_template, "absent": True, "context": context}
                        ]
                    },
                }
            ]
        },
    }


def not_found(name, method, path, key_template, context, priority=1):
    return {
        "name": name,
        "request": {
            "urlPathTemplate": path,
            "method": method,
            "customMatcher": require_absent(key_template, context),
        },
        "response": {
            "status": 404,
            "body": '{\n  "error": "not_found",\n  "message": "Resource not found"\n}',
            "headers": JSON_HDR,
        },
        "persistent": True,
        "priority": priority,
    }


def state_response(status, body_expr):
    return {
        "status": status,
        "body": "{{#formatJson}}\n  " + body_expr + "\n{{/formatJson}}",
        "headers": JSON_HDR,
        "transformers": ["response-template"],
    }


# ---------------------------------------------------------------- payments
create_payment = {
    "name": "Create payment (outcome driven by Test Cards data source)",
    "request": {
        "urlPathTemplate": "/payments",
        "method": "POST",
        "customMatcher": {
            "name": "custom-and-matcher",
            "parameters": {
                "matchers": [
                    {
                        "name": "data-exists",
                        "parameters": {
                            "id": CARDS_DS,
                            "matcherEnabled": True,
                            "query": "card_token = '{{jsonPath request.body '$.cardToken'}}'",
                        },
                    }
                ]
            },
        },
    },
    "response": state_response(201, "{{state paymentId context='payments'}}"),
    "persistent": True,
    "serveEventListeners": [
        change_state(
            var("paymentId", "pay_{{randomValue type='ALPHANUMERIC' length=10 uppercase=false}}"),
            var("outcome", "{{data.items.0.payment_status}}"),
            op(
                "SET",
                "payments",
                "{{paymentId}}",
                "{{#jsonMerge request.body removeNulls=true}}\n"
                "{\n"
                '  "id": "{{paymentId}}",\n'
                '  "status": "{{data.items.0.payment_status}}",\n'
                '  "responseCode": "{{data.items.0.response_code}}",\n'
                '  "responseMessage": "{{data.items.0.response_message}}",\n'
                '  "amountRefunded": 0,\n'
                '  "createdAt": "{{now}}",\n'
                '  "cardToken": null\n'
                "}\n"
                "{{/jsonMerge}}",
            ),
            # Only captured payments land in the 'refundable' context; the refund 409
            # guard is "absent from refundable".
            op(
                "SET",
                "{{#eq outcome 'succeeded'}}refundable{{else}}not-refundable{{/eq}}",
                "{{paymentId}}",
                '{\n  "refundable": true\n}',
            ),
        ),
    ],
    "postServeActions": [
        {"name": "webhook", "parameters": webhook("{{data.items.0.webhook_event}}", "{{state paymentId context='payments'}}")}
    ],
}

create_payment_unknown_card = {
    "name": "Create payment - unknown card token",
    "request": {"urlPathTemplate": "/payments", "method": "POST"},
    "response": {
        "status": 422,
        "body": '{\n  "error": "unknown_card",\n  "message": "Card token is not recognised"\n}',
        "headers": JSON_HDR,
    },
    "persistent": True,
    "priority": 10,
}

get_payment = {
    "name": "Get payment status",
    "request": {"urlPathTemplate": "/payments/{paymentId}", "method": "GET"},
    "response": state_response(200, "{{state request.path.paymentId context='payments'}}"),
    "persistent": True,
}

# ----------------------------------------------------------------- refunds
refund_not_refundable = {
    "name": "Create refund - payment not refundable (declined)",
    "request": {
        "urlPathTemplate": "/payments/{paymentId}/refunds",
        "method": "POST",
        "customMatcher": require_absent("{{request.path.paymentId}}", "refundable"),
    },
    "response": {
        "status": 409,
        "body": '{\n  "error": "payment_not_refundable",\n'
        '  "message": "Payment was not successful and cannot be refunded"\n}',
        "headers": JSON_HDR,
    },
    "persistent": True,
    "priority": 2,
}

create_refund = {
    "name": "Create refund (stateful, partial or full)",
    "request": {"urlPathTemplate": "/payments/{paymentId}/refunds", "method": "POST"},
    "response": state_response(201, "{{state refundId context='refunds'}}"),
    "persistent": True,
    "serveEventListeners": [
        change_state(
            var("paymentId", "{{request.path.paymentId}}"),
            var("refundId", "ref_{{randomValue type='ALPHANUMERIC' length=10 uppercase=false}}"),
            var("payment", "{{state paymentId context='payments'}}"),
            var("paymentAmount", "{{jsonPath payment '$.amount'}}"),
            var("alreadyRefunded", "{{jsonPath payment '$.amountRefunded'}}"),
            var("newRefunded", "{{math alreadyRefunded '+' (jsonPath request.body '$.amount')}}"),
            var("exceeds", "{{#if (gt (math newRefunded '-' paymentAmount) 0)}}yes{{else}}no{{/if}}"),
            var("refundStatus", "{{#eq exceeds 'yes'}}failed{{else}}succeeded{{/eq}}"),
            var(
                "failureReasonJson",
                "{{#eq exceeds 'yes'}}\"amount_exceeds_refundable\"{{else}}null{{/eq}}",
            ),
            var(
                "paymentStatus",
                "{{#eq exceeds 'yes'}}{{jsonPath payment '$.status'}}{{else}}"
                "{{#eq newRefunded paymentAmount}}refunded{{else}}partially_refunded{{/eq}}{{/eq}}",
            ),
            var("finalRefunded", "{{#eq exceeds 'yes'}}{{alreadyRefunded}}{{else}}{{newRefunded}}{{/eq}}"),
            op(
                "SET",
                "refunds",
                "{{refundId}}",
                "{{#jsonMerge request.body}}\n"
                "{\n"
                '  "id": "{{refundId}}",\n'
                '  "paymentId": "{{paymentId}}",\n'
                '  "currency": "{{jsonPath payment \'$.currency\'}}",\n'
                '  "status": "{{refundStatus}}",\n'
                '  "failureReason": {{failureReasonJson}},\n'
                '  "createdAt": "{{now}}"\n'
                "}\n"
                "{{/jsonMerge}}",
            ),
            op(
                "SET",
                "payment-{{paymentId}}-refunds",
                "{{refundId}}",
                "{{state refundId context='refunds'}}",
            ),
            op(
                "SET",
                "payments",
                "{{paymentId}}",
                "{{#jsonMerge previousValue}}\n"
                "{\n"
                '  "status": "{{paymentStatus}}",\n'
                '  "amountRefunded": {{finalRefunded}}\n'
                "}\n"
                "{{/jsonMerge}}",
            ),
        ),
    ],
    "postServeActions": [
        {"name": "webhook", "parameters": webhook("refund.{{refundStatus}}", "{{state refundId context='refunds'}}")}
    ],
}

list_refunds = {
    "name": "List refunds for payment",
    "request": {"urlPathTemplate": "/payments/{paymentId}/refunds", "method": "GET"},
    "response": state_response(200, "[{{arrayJoin ',' (listState refundsContext)}}]"),
    "persistent": True,
    "serveEventListeners": [
        change_state(var("refundsContext", "payment-{{request.path.paymentId}}-refunds"))
    ],
}

get_refund = {
    "name": "Get refund",
    "request": {"urlPathTemplate": "/refunds/{refundId}", "method": "GET"},
    "response": state_response(200, "{{state request.path.refundId context='refunds'}}"),
    "persistent": True,
}

mappings = [
    not_found("Not found - get payment", "GET", "/payments/{paymentId}", "{{request.path.paymentId}}", "payments"),
    not_found("Not found - create refund (payment missing)", "POST", "/payments/{paymentId}/refunds", "{{request.path.paymentId}}", "payments"),
    not_found("Not found - list refunds (payment missing)", "GET", "/payments/{paymentId}/refunds", "{{request.path.paymentId}}", "payments"),
    not_found("Not found - get refund", "GET", "/refunds/{refundId}", "{{request.path.refundId}}", "refunds"),
    create_payment,
    create_payment_unknown_card,
    get_payment,
    refund_not_refundable,
    create_refund,
    list_refunds,
    get_refund,
]

for _m in mappings:
    _m["id"] = STUB_IDS[_m["name"]]  # KeyError here means a stub was renamed: update STUB_IDS

if __name__ == "__main__":
    with open(sys.argv[1], "w") as f:
        json.dump({"mappings": mappings}, f, indent=2)
        f.write("\n")
    print(f"wrote {len(mappings)} mappings to {sys.argv[1]}")
