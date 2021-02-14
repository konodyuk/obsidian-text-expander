import re
import sys
import json

class Processor:
    def __init__(self, regex, function, text_preprocessor=None):
        self.regex = re.compile(regex)
        self.function = function
        self.preprocessor = text_preprocessor

    def test(self, text):
        return bool(self.regex.match(text))

    def process(self, text, context):
        if self.preprocessor is not None:
            text = self.preprocessor(text)
        return self.function(text, context)

class Handler:
    def __init__(self):
        self.processors = []

    @staticmethod
    def read_request():
        request = json.loads(input())
        return request

    @staticmethod
    def send_response(replacement):
        response = {"id": 0, "replacement": str(replacement)}
        print(json.dumps(response))

    def run(self):
        while True:
            try:
                request = self.read_request()
                replacement = self.find_replacement(request["text"], request["context"])
                if replacement is None:
                    continue
                self.send_response(replacement)
            except EOFError:
                return
            except Exception as e:
                print(e, file=sys.stderr)

    def find_replacement(self, text, context):
        for processor in self.processors:
            if processor.test(text):
                return processor.process(text, context)
        return None

    def regex(self, regex, text_preprocessor=None):
        def wrapper(function):
            processor = Processor(regex, function, text_preprocessor)
            self.processors.append(processor)
            return function
        return wrapper

    def command(self, string=None, prefix=None, cut_prefix=True):
        if string is not None:
            return self.regex(f"^{string}$")
        if prefix is not None:
            text_preprocessor = None
            if cut_prefix:
                text_preprocessor = lambda x: x[len(prefix):]
            return self.regex(f"^{prefix}", text_preprocessor=text_preprocessor)

handler = Handler()

# ========== PROCESSORS:START ==========

from datetime import datetime, timedelta

@handler.command(prefix="now", cut_prefix=True)
def now_handler(text, context):
    now = datetime.now()
    if len(text):
        if text.endswith("h"):
            delta = timedelta(hours=eval(text[:-1]))
        elif text.endswith("m"):
            delta = timedelta(minutes=eval(text[:-1]))
        else:
            delta = timedelta(minutes=eval(text))
        now += delta
    return now.strftime("%H:%M")

@handler.command(prefix="today", cut_prefix=True)
def today_handler(text, context):
    now = datetime.now()
    if len(text):
        delta = timedelta(days=eval(text))
        now += delta
    return now.strftime("%Y-%m-%d")

sympy_preamble = """
try:
    from sympy import *
except ImportError:
    SYMPY_AVAILABLE = False
else:
    SYMPY_AVAILABLE = True

if SYMPY_AVAILABLE:
    x, y, z, t = symbols('x y z t')
"""
sympy_namespace = dict()
exec(sympy_preamble, sympy_namespace)

@handler.command(prefix="sympy:", cut_prefix=True)
def sympy_handler(text, context):
    if not sympy_namespace["SYMPY_AVAILABLE"]:
        raise UserWarning("Sympy not available, install it with pip")
    return eval(f"latex({text})", sympy_namespace)

@handler.command(prefix="shell:", cut_prefix=True)
def shell_handler(text, context):
    raise NotImplementedError()

@handler.command(prefix="draw:", cut_prefix=True)
def draw_handler(text, context):
    raise NotImplementedError()

# ========== PROCESSORS:END ==========

if __name__ == "__main__":
    handler.run()
