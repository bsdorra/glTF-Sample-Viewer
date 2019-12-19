layout (location=0) in vec4 a_position;
out vec2 v_PixelCoord;

void main() {
  v_PixelCoord = a_position.xy;
  gl_Position = a_position;
}
