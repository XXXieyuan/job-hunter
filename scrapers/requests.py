from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class Response:
    def __init__(self, url, status_code, content, headers):
        self.url = url
        self.status_code = status_code
        self.content = content
        self.headers = headers
        self.text = content.decode("utf-8", errors="ignore")

    def json(self):
        import json

        return json.loads(self.text)


class Session:
    def __init__(self):
        self.headers = {}

    def get(self, url, params=None, timeout=20):
        if params:
            query = urlencode(params, doseq=True)
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}{query}"

        request = Request(url, headers=self.headers)

        try:
            with urlopen(request, timeout=timeout) as response:
                return Response(
                    url=response.geturl(),
                    status_code=response.status,
                    content=response.read(),
                    headers=dict(response.headers.items()),
                )
        except HTTPError as error:
            return Response(
                url=url,
                status_code=error.code,
                content=error.read(),
                headers=dict(error.headers.items()),
            )
        except URLError as error:
            raise RuntimeError(str(error)) from error
