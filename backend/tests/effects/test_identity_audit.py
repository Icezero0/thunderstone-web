"""The inventory separates exact supply operations from semantic target filters."""

import unittest

from backend.scripts.effects.audit_effect_identity import (
    CLASS_FIELDS, IDENTITY_FIELDS, collect, predicates, summary, violations,
)


class IdentityAuditTests(unittest.TestCase):
    def test_published_target_predicates_have_no_unapproved_legacy_identity_filter(self):
        _, rows = collect(IDENTITY_FIELDS)
        self.assertEqual(violations(rows), [])
        exact = {(row["ability_id"], row["path"], row["value"]) for row in rows
                 if row["field"] in {"card_id", "exclude_card_id", "hero_card_id", "equipper_card_id"}}
        self.assertEqual(exact, {
            ("TS-0522-A01", "$.body.card_id", "TS-0001"),
            ("TS-0601-A01", "$.body.card_id", "TS-0001"),
            ("TS-0634-A01", "$.body.query.card_id", "TS-0002"),
        })
        self.assertEqual(summary(rows)["abilities"], 467)
        self.assertEqual(summary(rows)["mechanics"], 206)

    def test_default_collection_remains_compatible_with_classification_audits(self):
        _, rows = collect()
        self.assertTrue(all(row["field"] in CLASS_FIELDS for row in rows))

    def test_fixed_militia_supply_exception_cannot_hide_a_target_query_or_equipper_filter(self):
        row = {"ability_id": "TS-0522-A01", "path": "$.body.card_id", "field": "card_id", "value": "TS-0001"}
        self.assertEqual(violations([row]), [])
        for change in ({"path": "$.body.query.card_id"}, {"field": "equipper_card_id"}, {"ability_id": "TS-0231-A02"}):
            self.assertEqual(len(violations([{**row, **change}])), 1)
        self.assertEqual(len(violations([{**row, "field": "name", "value": "民兵"}])), 1)

    def test_nested_name_and_equipper_predicates_are_inventory_entries_not_source_bindings(self):
        node = {"source_card_id": "TS-0001", "body": {"query": {
            "same_name_as_var": "chosen", "equipper_card_id": "TS-0001"}}}
        found = list(predicates(node, fields=IDENTITY_FIELDS))
        self.assertEqual({field for _, field, _ in found}, {"same_name_as_var", "equipper_card_id"})


if __name__ == "__main__":
    unittest.main()
