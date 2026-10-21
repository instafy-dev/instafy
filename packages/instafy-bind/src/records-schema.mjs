// instafy.records@1: the records file every executor's results are checked against and the binder writes.
// Validated with schema-lite (oneOf, $ref, $defs, maxProperties and additionalProperties-as-schema).
export const RECORDS_SCHEMA = Object.freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://instafy.dev/schemas/instafy.records@1.json",
  "type": "object",
  "required": [
    "schema",
    "records"
  ],
  "properties": {
    "schema": {
      "const": "instafy.records@1"
    },
    "writer": {
      "type": "object"
    },
    "attribution": {
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 300
      },
      "maxItems": 10
    },
    "records": {
      "type": "array",
      "maxItems": 2000,
      "items": {
        "oneOf": [
          {
            "$ref": "#/$defs/claim"
          },
          {
            "$ref": "#/$defs/offer"
          },
          {
            "$ref": "#/$defs/item"
          }
        ]
      }
    }
  },
  "$defs": {
    "rid": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_.:-]{1,96}$"
    },
    "ref": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,47}:[^\\s]{1,120}$"
    },
    "basis": {
      "enum": [
        "measured",
        "routed",
        "counted",
        "estimated",
        "registry",
        "filed",
        "live",
        "brand",
        "user_note",
        "editorial",
        "modelled",
        "inferred"
      ]
    },
    "confidence": {
      "enum": [
        "high",
        "medium",
        "low"
      ]
    },
    "text": {
      "type": "string",
      "maxLength": 140
    },
    "https": {
      "type": "string",
      "maxLength": 2000,
      "pattern": "^https://|^http://(localhost|127\\.0\\.0\\.1)(:|/)"
    },
    "prov": {
      "type": "object",
      "required": [
        "source",
        "lane",
        "observed_at",
        "ttl_s"
      ],
      "additionalProperties": false,
      "properties": {
        "source": {
          "type": "string",
          "maxLength": 80
        },
        "source_label": {
          "type": "string",
          "maxLength": 80
        },
        "lane": {
          "enum": [
            "link",
            "official",
            "open",
            "capture",
            "feed",
            "assist",
            "local"
          ]
        },
        "url": {
          "$ref": "#/$defs/https"
        },
        "observed_at": {
          "type": "string",
          "format": "date-time"
        },
        "observed_by": {
          "type": "string",
          "maxLength": 80
        },
        "observer": {
          "type": "string",
          "maxLength": 80
        },
        "as_of": {
          "type": "string",
          "maxLength": 32
        },
        "ttl_s": {
          "type": "integer",
          "minimum": 0
        },
        "ttl": {
          "type": "integer",
          "minimum": 0
        },
        "class": {
          "enum": [
            "stored",
            "live"
          ]
        },
        "license": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "store": {
              "enum": [
                "none",
                "ids",
                "ttl",
                "full"
              ]
            },
            "attribution": {
              "type": "string",
              "maxLength": 300
            },
            "url": {
              "$ref": "#/$defs/https"
            }
          }
        },
        "adapter": {
          "type": "string",
          "maxLength": 60
        },
        "job": {
          "type": "string",
          "maxLength": 80
        },
        "intent": {
          "type": "object",
          "required": [
            "name"
          ],
          "properties": {
            "name": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_]{0,47}$"
            },
            "params": {
              "type": "object"
            },
            "id": {
              "type": "string",
              "maxLength": 40
            }
          }
        },
        "snapshot_sha256": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$"
        },
        "sandbox": {
          "type": "boolean"
        },
        "logged_in": {
          "const": false
        },
        "refresh_days": {
          "type": "number",
          "minimum": 1,
          "maximum": 3650
        },
        "tier": {
          "type": "string",
          "maxLength": 20
        },
        "requested_by": {
          "type": "string",
          "maxLength": 80
        },
        "task": {
          "type": "string",
          "maxLength": 80
        },
        "rid": {
          "type": "string",
          "maxLength": 120
        }
      }
    },
    "claim": {
      "type": "object",
      "required": [
        "type",
        "cid",
        "ref",
        "attr",
        "basis",
        "prov"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "claim"
        },
        "cid": {
          "$ref": "#/$defs/rid"
        },
        "ref": {
          "$ref": "#/$defs/ref"
        },
        "attr": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9_]{0,47}$"
        },
        "value": {
          "type": [
            "string",
            "number",
            "boolean",
            "null"
          ],
          "maxLength": 140
        },
        "unit": {
          "type": "string",
          "maxLength": 12
        },
        "label": {
          "type": "string",
          "maxLength": 60
        },
        "note": {
          "$ref": "#/$defs/text"
        },
        "status": {
          "enum": [
            "ok",
            "not_found",
            "uncertain",
            "error"
          ]
        },
        "basis": {
          "$ref": "#/$defs/basis"
        },
        "confidence": {
          "$ref": "#/$defs/confidence"
        },
        "match": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "confidence": {
              "$ref": "#/$defs/confidence"
            },
            "by": {
              "type": "array",
              "items": {
                "enum": [
                  "id",
                  "phone",
                  "address",
                  "name",
                  "geo"
                ]
              },
              "maxItems": 5
            },
            "dist_m": {
              "type": "number",
              "minimum": 0
            },
            "candidate": {
              "type": "string",
              "maxLength": 120
            }
          }
        },
        "prov": {
          "$ref": "#/$defs/prov"
        }
      }
    },
    "offer": {
      "type": "object",
      "required": [
        "type",
        "oid",
        "ref",
        "price",
        "prov"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "offer"
        },
        "oid": {
          "$ref": "#/$defs/rid"
        },
        "ref": {
          "$ref": "#/$defs/ref"
        },
        "vid": {
          "$ref": "#/$defs/rid"
        },
        "variant": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "checkin": {
              "type": "string",
              "format": "date"
            },
            "checkout": {
              "type": "string",
              "format": "date"
            },
            "guests": {
              "type": "integer",
              "minimum": 1,
              "maximum": 30
            },
            "rooms": {
              "type": "integer",
              "minimum": 1,
              "maximum": 10
            },
            "label": {
              "type": "string",
              "maxLength": 80
            }
          }
        },
        "seller": {
          "type": "object",
          "required": [
            "name"
          ],
          "additionalProperties": false,
          "properties": {
            "name": {
              "type": "string",
              "maxLength": 80
            },
            "trust": {
              "enum": [
                "curated",
                "unknown"
              ]
            }
          }
        },
        "price": {
          "type": "object",
          "required": [
            "amount",
            "currency"
          ],
          "additionalProperties": false,
          "properties": {
            "amount": {
              "type": "number",
              "minimum": 0
            },
            "currency": {
              "type": "string",
              "pattern": "^[A-Z]{3}$"
            },
            "kind": {
              "enum": [
                "total",
                "nightly",
                "from",
                "regular",
                "sale",
                "member"
              ]
            },
            "taxes_included": {
              "enum": [
                "yes",
                "no",
                "unknown"
              ]
            }
          }
        },
        "refundable": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "availability": {
          "enum": [
            "in_stock",
            "out",
            "unknown"
          ]
        },
        "handoff": {
          "type": "object",
          "required": [
            "url"
          ],
          "additionalProperties": false,
          "properties": {
            "url": {
              "$ref": "#/$defs/https"
            },
            "label": {
              "type": "string",
              "maxLength": 40
            },
            "affiliate": {
              "type": "boolean"
            }
          }
        },
        "label": {
          "type": "string",
          "maxLength": 80
        },
        "basis": {
          "$ref": "#/$defs/basis"
        },
        "prov": {
          "$ref": "#/$defs/prov"
        },
        "expires_at": {
          "type": "string",
          "format": "date-time"
        },
        "free_until": {
          "type": "string",
          "format": "date-time"
        },
        "display": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "photos": {
              "type": "boolean"
            },
            "reviews": {
              "type": "boolean"
            },
            "ai_summary": {
              "type": "boolean"
            }
          }
        }
      }
    },
    "item": {
      "type": "object",
      "required": [
        "type",
        "iid",
        "kind",
        "name",
        "geo",
        "prov"
      ],
      "additionalProperties": false,
      "properties": {
        "type": {
          "const": "item"
        },
        "iid": {
          "$ref": "#/$defs/rid"
        },
        "layer": {
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$"
        },
        "kind": {
          "type": "string",
          "maxLength": 40
        },
        "name": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "local": {
              "type": "string",
              "maxLength": 120
            },
            "en": {
              "type": "string",
              "maxLength": 120
            }
          }
        },
        "geo": {
          "type": "object",
          "required": [
            "lng",
            "lat"
          ],
          "additionalProperties": false,
          "properties": {
            "lng": {
              "type": "number",
              "minimum": -180,
              "maximum": 180
            },
            "lat": {
              "type": "number",
              "minimum": -90,
              "maximum": 90
            }
          }
        },
        "keys": {
          "type": "object",
          "additionalProperties": {
            "type": "string",
            "maxLength": 120
          }
        },
        "props": {
          "type": "object",
          "maxProperties": 30,
          "additionalProperties": {
            "type": [
              "string",
              "number",
              "boolean",
              "null"
            ],
            "maxLength": 140
          }
        },
        "prov": {
          "$ref": "#/$defs/prov"
        }
      }
    }
  }
});
