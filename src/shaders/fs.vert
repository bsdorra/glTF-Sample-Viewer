layout (location=0) in vec4 a_position;
out vec2 uv;
void main() {
	uv = (a_position.xy + vec2(1.0)) * 0.5;
	gl_Position = a_position;
}
