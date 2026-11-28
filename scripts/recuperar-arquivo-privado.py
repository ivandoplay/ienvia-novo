#!/usr/bin/env python3
"""Recupera um TAR.XZ cifrado; não extrai, não acessa rede nem altera produção."""
import argparse, base64, hashlib, json
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--key', type=Path, required=True, help='JSON privado de chave/manifesto, fora do Git')
    parser.add_argument('--output', type=Path, required=True, help='Novo caminho .tar.xz de saída')
    parser.add_argument('parts', type=Path, nargs='+', help='Partes cifradas baixadas, na ordem 01, 02...')
    args = parser.parse_args()
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # pip install cryptography
    config = json.loads(args.key.read_text())
    if len(args.parts) != len(config['parts']):
        parser.error('Quantidade de partes não corresponde ao manifesto.')
    if args.output.exists():
        parser.error('A saída já existe; não será sobrescrita.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp = args.output.with_name(args.output.name + '.parcial')
    cipher = AESGCM(base64.b64decode(config['key_base64']))
    digest = hashlib.sha256(); total = 0
    try:
        with temp.open('xb') as out:
            temp.chmod(0o600)
            for p, meta in zip(args.parts, config['parts']):
                encrypted = p.read_bytes()
                if hashlib.sha256(encrypted).hexdigest() != meta['sha256']:
                    raise ValueError('SHA-256 da parte não corresponde ao manifesto.')
                if not encrypted.startswith(b'IENVIA-AESGCM-1\n'):
                    raise ValueError('Cabeçalho desconhecido.')
                payload = cipher.decrypt(encrypted[16:28], encrypted[28:], meta['aad'].encode())
                out.write(payload); digest.update(payload); total += len(payload)
        if digest.hexdigest() != config['original_sha256'] or total != config['original_bytes']:
            raise ValueError('Arquivo final não corresponde ao original.')
        temp.rename(args.output)
    except Exception:
        if temp.exists(): temp.unlink()
        raise
    print('OK: arquivo recuperado e validado. Inspecione o TAR antes de extrair em uma pasta NOVA.')

if __name__ == '__main__':
    main()
