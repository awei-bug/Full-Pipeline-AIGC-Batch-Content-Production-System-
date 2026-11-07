import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


class GeneratedCopyPreservationTest(unittest.TestCase):
    def test_missing_copy_preserves_old_pair_and_new_copy_replaces_it(self):
        with tempfile.TemporaryDirectory(prefix='hub-copy-test-') as temp:
            old = os.environ.get('HUB_DB_PATH')
            os.environ['HUB_DB_PATH'] = str(Path(temp) / 'hub.sqlite')
            try:
                spec = importlib.util.spec_from_file_location('isolated_hub_copy_test', Path(__file__).with_name('app.py'))
                hub = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(hub)
                hub.init_db()
                conn = hub.connect()
                try:
                    def write(**fields):
                        result = hub.upsert_item(conn, 'demo', {'external_id': 'p1', 'title': '商品', **fields}, 'test', 'job')
                        conn.commit()
                        return result
                    write(title_en='Title 1', desc_en='Body 1', declare_name_en='Title 1')
                    write(preserve_generated_copy=True, stock=4)
                    item = hub.row_to_record(conn.execute('select * from hub_products where external_id=?', ('p1',)).fetchone())
                    self.assertEqual((item['title_en'], item['desc_en'], item['declare_name_en']), ('Title 1', 'Body 1', 'Title 1'))
                    write(title_en='Title 2', desc_en='Body 2', declare_name_en='Title 2')
                    item = hub.row_to_record(conn.execute('select * from hub_products where external_id=?', ('p1',)).fetchone())
                    self.assertEqual((item['title_en'], item['desc_en']), ('Title 2', 'Body 2'))
                    write(title_en='Title only')
                    item = hub.row_to_record(conn.execute('select * from hub_products where external_id=?', ('p1',)).fetchone())
                    self.assertIsNone(item['desc_en'])
                finally:
                    conn.close()
            finally:
                if old is None:
                    os.environ.pop('HUB_DB_PATH', None)
                else:
                    os.environ['HUB_DB_PATH'] = old


if __name__ == '__main__':
    unittest.main()
