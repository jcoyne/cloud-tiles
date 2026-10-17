# Test data (not committed)

- `stanford-army.jp2`: <https://stacks.stanford.edu/file/bb002wb0348/PC0170_s3_Army_2014-09-13_122754_0529.jp2>
  (Kakadu 7.1, 6000×4000, untiled, RPCL, 7 layers, PLT, no TLM).
- `stanford-army.tif`: `kdu_expand -i stanford-army.jp2 -o stanford-army.tif`
- Variants: `../scripts/encode-variants.sh stanford-army.tif .`

```bash
curl -o testdata/stanford-army.jp2 https://stacks.stanford.edu/file/bb002wb0348/PC0170_s3_Army_2014-09-13_122754_0529.jp2
kdu_expand -i testdata/stanford-army.jp2 -o testdata/stanford-army.tif
scripts/encode-variants.sh testdata/stanford-army.tif testdata
```
