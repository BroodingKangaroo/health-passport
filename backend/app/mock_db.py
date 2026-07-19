def _status(value: float, rmin: float, rmax: float) -> str:
    if value < rmin:
        return "low"
    if value > rmax:
        return "high"
    return "normal"