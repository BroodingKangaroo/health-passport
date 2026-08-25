"""Small text helpers shared across matcher modules."""



def _is_ascii(text: str) -> bool:
    try:
        text.encode("ascii")
        return True
    except (UnicodeEncodeError, AttributeError):
        return False
