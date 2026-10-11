import asyncio
import unittest

from app.cost import compute_cost, summarize_costs


class CostTests(unittest.IsolatedAsyncioTestCase):
    def test_computes_from_prompt_and_completion_tokens(self):
        cost = compute_cost({"prompt_tokens": 1000, "completion_tokens": 2000}, "agnes-2.5-flash")
        self.assertEqual(cost.input_tokens, 1000)
        self.assertEqual(cost.output_tokens, 2000)
        # agnes-2.5: 0.004/1k 输入, 0.012/1k 输出
        self.assertAlmostEqual(cost.input_cost, 0.004, places=6)
        self.assertAlmostEqual(cost.output_cost, 0.024, places=6)
        self.assertAlmostEqual(cost.total_cost, 0.028, places=6)
        self.assertEqual(cost.currency, "CNY")

    def test_splits_total_tokens_when_breakdown_missing(self):
        cost = compute_cost({"total_tokens": 1000}, "Qwen/Qwen2.5-7B-Instruct")
        self.assertEqual(cost.input_tokens + cost.output_tokens, 1000)
        self.assertGreater(cost.total_cost, 0)

    def test_unknown_model_costs_zero(self):
        cost = compute_cost({"prompt_tokens": 100, "completion_tokens": 100}, "mystery-model")
        self.assertEqual(cost.total_cost, 0.0)

    def test_summarize_aggregates_batch_costs(self):
        items = [
            {"result": {"cost": {"totalCost": 0.028, "model": "agnes-2.5-flash"}}},
            {"result": {"cost": {"totalCost": 0.01, "model": "Qwen/Qwen2.5-7B-Instruct"}}},
            {"result": None},
        ]
        summary = summarize_costs(items)
        self.assertEqual(summary["chaptersCounted"], 2)
        self.assertAlmostEqual(summary["totalCost"], 0.038, places=6)
        self.assertIn("agnes-2.5-flash", summary["byModel"])


if __name__ == "__main__":
    unittest.main()
