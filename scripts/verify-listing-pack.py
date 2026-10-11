# -*- coding: utf-8 -*-
"""验证导出的成品包能被电商侧 listing_pack 解析。

只复刻 flask_shop/utils/listing_pack.py 中与 Flask 无关的解析逻辑，
用于确认包结构、字段识别和缺价跳过行为。
"""
import json
import os
import sys
import zipfile

PACK = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'storage', 'listing-pack-demo.zip')

_NAME_KEYS = ('name', '商品名称', '品名', '标题', 'title')
_PRICE_KEYS = ('price', '价格', '售价', '单价')
_STOCK_KEYS = ('stock', 'number', '库存', '数量')
_INTRO_KEYS = ('introduce', 'desc', 'description', '简介', '描述', '详情', '卖点')
_IMAGE_KEYS = ('images', 'pics', '图片', '主图')


def _pick(data, keys):
    lower = {str(k).strip().lower(): v for k, v in data.items()}
    for k in keys:
        if k.lower() in lower:
            return lower[k.lower()]
    return None


def main():
    if not os.path.exists(PACK):
        print('找不到成品包:', PACK)
        return 1

    with zipfile.ZipFile(PACK) as zf:
        broken = zf.testzip()
        print('CRC 校验:', '通过' if broken is None else f'失败于 {broken}')
        names = zf.namelist()
        print('包内文件数:', len(names))
        for n in names:
            info = zf.getinfo(n)
            print(f'  {n}  {info.file_size / 1024:.0f} KB')

        manifest = json.loads(zf.read('products.json').decode('utf-8'))
        products = manifest.get('products') or []
        print('')
        print('publish 标志:', manifest.get('publish'))

        created, skipped = [], []
        for row in products:
            name = str(_pick(row, _NAME_KEYS) or '').strip()
            price = _pick(row, _PRICE_KEYS)
            images = _pick(row, _IMAGE_KEYS) or []
            missing_images = [i for i in images if i not in names]
            if not name:
                skipped.append((name or '(无名)', '缺少商品名称'))
                continue
            if price is None:
                skipped.append((name, '缺少价格，已跳过（不会瞎填价格）'))
                continue
            created.append((name, price, len(images), len(missing_images)))
            if missing_images:
                print(f'  警告 {name} 缺图: {missing_images}')

        print('')
        print('=== 模拟上架结果 ===')
        for name, price, img_count, missing in created:
            print(f'  上架成功  {name}  价格 {price}  图片 {img_count} 张')
        for name, reason in skipped:
            print(f'  跳过      {name}  {reason}')
        print('')
        print(f'合计：成功 {len(created)} 件，跳过 {len(skipped)} 件')
    return 0


if __name__ == '__main__':
    sys.exit(main())
