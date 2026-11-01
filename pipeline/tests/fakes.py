import io
import json

from botocore.exceptions import ClientError


def client_error(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, operation)


class FakeS3:
    """In-memory S3 with just the calls the pipeline uses, including conditional writes."""

    def __init__(self, objects: dict[tuple[str, str], bytes] | None = None):
        self.objects: dict[tuple[str, str], bytes] = {}
        self.etags: dict[tuple[str, str], str] = {}
        self.puts: list[dict] = []
        self._writes = 0
        for (bucket, key), body in (objects or {}).items():
            self._store(bucket, key, body)

    def _store(self, bucket: str, key: str, body: bytes) -> None:
        self._writes += 1
        self.objects[(bucket, key)] = body
        self.etags[(bucket, key)] = f'"etag-{self._writes}"'

    def put_json(self, bucket: str, key: str, value) -> None:
        self._store(bucket, key, json.dumps(value).encode())

    def head_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise client_error("404", "HeadObject")
        return {"ContentLength": len(self.objects[(Bucket, Key)])}

    def get_object(self, Bucket, Key):
        if (Bucket, Key) not in self.objects:
            raise client_error("NoSuchKey", "GetObject")
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)]), "ETag": self.etags[(Bucket, Key)]}

    def put_object(self, Bucket, Key, Body, IfMatch=None, IfNoneMatch=None, **kwargs):
        exists = (Bucket, Key) in self.objects
        if IfNoneMatch == "*" and exists:
            raise client_error("PreconditionFailed", "PutObject")
        if IfMatch is not None and (not exists or self.etags[(Bucket, Key)] != IfMatch):
            raise client_error("PreconditionFailed", "PutObject")
        self._store(Bucket, Key, Body)
        self.puts.append({"Bucket": Bucket, "Key": Key, **kwargs})
        return {}
