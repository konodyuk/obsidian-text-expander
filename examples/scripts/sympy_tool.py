try:
    from sympy import *
except ImportError:
    SYMPY_AVAILABLE = False
else:
    SYMPY_AVAILABLE = True

def main():
    if not SYMPY_AVAILABLE:
        return
    x, y, z, t = symbols('x y z t')
    print(eval(input()), end="")

if __name__ == "__main__":
    main()
