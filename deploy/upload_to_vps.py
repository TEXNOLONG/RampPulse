import urllib.request
import urllib.error
import uuid
from pathlib import Path

def upload():
    boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
    data = []
    data.append(f'--{boundary}'.encode('ascii'))
    data.append(b'Content-Disposition: form-data; name="file"; filename="deploy_go.sh"')
    data.append(b'Content-Type: text/x-sh\r\n')
    data.append(Path('deploy/deploy_go_vps.sh').read_bytes())
    data.append(f'--{boundary}--\r\n'.encode('ascii'))
    body = b'\r\n'.join(data)

    req = urllib.request.Request('http://31.56.179.117/api/chat/upload', data=body)
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    req.add_header('User-Agent', 'RampPulseDeployer/1.0')

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            print('UPLOAD_OK:', resp.read().decode('utf-8'))
    except Exception as e:
        print('UPLOAD_ERR:', e)

if __name__ == '__main__':
    upload()
