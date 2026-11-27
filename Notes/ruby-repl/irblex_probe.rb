require "irb"
lex = IRB::RubyLex.new
cases = ["def f\n", "def f\n  1\nend\n", "1 +* 2\n", "end\n", "[1,\n", "foo(\n", "x = \"abc\n", "1 +\n", "if x\n", "class A; def b\n", "<<~E\nhi\n", "1)\n", "def f\n  1 +* 2\n", "{a: \n", "puts 'hi' if\n", "x = 1 \\\n", "=begin\n", "foo do |x|\n", "%w[a b\n", "1 + 2\nend\n", "x.\n", "foo\n  .bar\n", "1 +\n2\n", "def f(\n", "[1,2]]\n", "p 1\n"]
cases.each do |c|
  _t, opens, term = lex.check_code_state(c, local_variables: [])
  printf "%-22s terminated=%-5s opens=%d\n", c.inspect, term, opens.size
end
