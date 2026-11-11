from pathlib import Path
import re
root=Path('/opt/nvm/versions/node/v22.16.0/lib/node_modules/npm/node_modules/qrcode-terminal/vendor/QRCode')
order=['QRMode','QRErrorCorrectLevel','QRMaskPattern','QRMath','QRPolynomial','QRRSBlock','QRBitBuffer','QR8bitByte','QRUtil','index']
parts=['/* QRCode for JavaScript by Kazuhiko Arase (MIT); local vendored copy from npm qrcode-terminal. */','const VeilQrGenerator = (() => {','  const VQR = {};']
for name in order:
 s=(root/(name+'.js')).read_text(encoding='utf-8')
 s,n=re.subn(r"require\(['\"]\./(\w+)['\"]\)",lambda m:"VQR."+m.group(1),s)
 parts.append('  VQR.'+name+' = (() => {\n    const module = {exports: {}};\n'+s+'\n    return module.exports;\n  })();')
parts.append('  return VQR.index;\n})();')
Path('/mnt/data/VEIL_P2P_Project/qr_vendor.js').write_text('\n'.join(parts),encoding='utf-8')
print('bundled QR',sum(map(len,parts)))
