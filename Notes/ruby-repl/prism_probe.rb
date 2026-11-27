require "prism"
cases = ["def f\n", "def f\n  1\nend\n", "1 +* 2\n", "end\n", "[1,\n", "foo(\n", "x = \"abc\n", "1 +\n", "if x\n", "class A; def b\n", "<<~E\nhi\n", "1)\n", "def f\n  1 +* 2\n", "{a: \n", "puts 'hi' if\n", "x = 1 \\\n", "=begin\n", "foo do |x|\n", "%w[a b\n", "1 + 2\nend\n"]
cases.each do |c|
  r = Prism.parse(c)
  errs = r.errors.map { |e| [e.type, e.location.start_offset, e.location.end_offset] }
  printf "%-22s len=%-3d %p\n", c.inspect, c.bytesize, errs
end
